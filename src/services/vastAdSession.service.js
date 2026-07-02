import crypto from 'crypto';
import { supabase } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';
import { isMissingDbFeature } from './revenueCalculation.service.js';
import { creditValidAdView } from './creatorAdReward.service.js';
import { userHasPremiumAccess } from './playbackAccess.service.js';

const SESSION_TTL_SEC = Number(process.env.VAST_AD_SESSION_TTL_SEC) || 600;
const UNLOCK_TTL_SEC = Number(process.env.VAST_AD_UNLOCK_TTL_SEC) || 600;
const AD_METADATA_READ_TIMEOUT_MS = Number(process.env.AD_METADATA_READ_TIMEOUT_MS) || 3500;
const VAST_PROBE_TIMEOUT_MS = Number(process.env.VAST_PROBE_TIMEOUT_MS) || 4500;
const VAST_PROBE_CACHE_MS = Number(process.env.VAST_PROBE_CACHE_MS) || 60_000;
const APPROVED_DEFAULT_VAST_TAG = 'https://s.magsrv.com/v1/vast.php?idz=5963164';
const LEGACY_DEFAULT_VAST_TAGS = new Set([
  'https://s.magsrv.com/v1/vast.php?idz=5932212',
  'https://s.magsrv.com/v1/vast.php?idz=5933056',
  'https://s.magsrv.com/v1/vast.php?idzone=5932212',
  'https://s.magsrv.com/v1/vast.php?idzone=5933056',
]);
const DEFAULT_VAST_TAG = process.env.EXOCLICK_VAST_TAG_URL
  || APPROVED_DEFAULT_VAST_TAG;
const vastProbeCache = new Map();
const memoryAdSessions = new Map();

function normalizeVastTagUrl(url) {
  const value = String(url || '').trim();
  return LEGACY_DEFAULT_VAST_TAGS.has(value) ? APPROVED_DEFAULT_VAST_TAG : value;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label || 'operation'} timed out`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, Math.max(500, Number(timeoutMs) || AD_METADATA_READ_TIMEOUT_MS));
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function shouldProbeVastTags() {
  return String(process.env.VAST_AD_PROBE_ENABLED ?? 'false').toLowerCase() === 'true';
}

function safeVastDiagnostics(result) {
  if (!result) return null;
  return {
    ok: result.ok,
    reason: result.reason || null,
    status: result.status || null,
    contentType: result.contentType || null,
    bytes: result.bytes || 0,
    hasAd: Boolean(result.hasAd),
    noFill: Boolean(result.noFill),
    hasWrapper: Boolean(result.hasWrapper),
    wrapperCount: result.wrapperCount || 0,
    inlineCount: result.inlineCount || 0,
    linearCount: result.linearCount || 0,
    vastAdTagUriCount: result.vastAdTagUriCount || 0,
    hasPlayableWrapper: Boolean(result.hasPlayableWrapper),
    hasMediaFile: Boolean(result.hasMediaFile),
    mediaFileCount: result.mediaFileCount || 0,
    tagUrl: result.tagUrl,
    cached: Boolean(result.cached),
  };
}

function analyzeVastXml(xml) {
  const body = String(xml || '');
  const hasVast = /<VAST(?=[\s>])/i.test(body);
  const adCount = (body.match(/<Ad(?=[\s>])/gi) || []).length;
  const wrapperCount = (body.match(/<Wrapper\b/gi) || []).length;
  const inlineCount = (body.match(/<InLine\b/gi) || []).length;
  const linearCount = (body.match(/<Linear\b/gi) || []).length;
  const vastAdTagUriCount = (body.match(/<VASTAdTagURI\b/gi) || []).length;
  const mediaFileCount = (body.match(/<MediaFile\b/gi) || []).length;
  const hasAd = adCount > 0;
  const hasWrapper = wrapperCount > 0;
  const hasMediaFile = mediaFileCount > 0;
  const hasPlayableWrapper = hasWrapper && vastAdTagUriCount > 0;
  const summary = {
    hasVast,
    hasAd,
    adCount,
    hasWrapper,
    wrapperCount,
    inlineCount,
    linearCount,
    vastAdTagUriCount,
    hasPlayableWrapper,
    hasMediaFile,
    mediaFileCount,
  };
  if (!body.trim()) {
    return { ok: false, reason: 'empty_response', ...summary };
  }
  if (!hasVast) {
    return { ok: false, reason: 'malformed_vast', ...summary };
  }
  if (!hasAd) {
    return { ok: false, reason: 'no_fill', legacyReason: 'empty_vast', noFill: true, ...summary };
  }
  if (!hasMediaFile && !hasPlayableWrapper) {
    return { ok: false, reason: 'missing_media_file', ...summary };
  }
  return { ok: true, reason: null, ...summary };
}

async function probeVastTagAvailability(tagUrl) {
  const normalized = normalizeVastTagUrl(tagUrl);
  if (!normalized) return { ok: false, reason: 'missing_tag_url', tagUrl: normalized };
  try {
    const parsed = new URL(normalized);
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return { ok: false, reason: 'invalid_tag_url', tagUrl: normalized };
    }
  } catch {
    return { ok: false, reason: 'invalid_tag_url', tagUrl: normalized };
  }

  const cached = vastProbeCache.get(normalized);
  if (cached && Date.now() - cached.checkedAt < VAST_PROBE_CACHE_MS) {
    return { ...cached.result, cached: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1500, VAST_PROBE_TIMEOUT_MS));
  try {
    const response = await fetch(normalized, {
      signal: controller.signal,
      headers: {
        Accept: 'application/xml,text/xml,*/*',
        'User-Agent': 'Mozilla/5.0 (compatible; XStreamVideos-AdProbe/1.0)',
      },
    });
    const text = await response.text();
    const analysis = analyzeVastXml(text);
    const result = {
      ...analysis,
      tagUrl: normalized,
      status: response.status,
      contentType: response.headers.get('content-type') || null,
      bytes: Buffer.byteLength(text || '', 'utf8'),
    };
    if (!response.ok) {
      result.ok = false;
      result.reason = `http_${response.status}`;
    }
    vastProbeCache.set(normalized, { checkedAt: Date.now(), result });
    return result;
  } catch (err) {
    const result = {
      ok: false,
      reason: err?.name === 'AbortError' ? 'vast_probe_timeout' : 'vast_probe_failed',
      tagUrl: normalized,
      message: err?.message || String(err),
      uncertain: true,
    };
    vastProbeCache.set(normalized, { checkedAt: Date.now(), result });
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveAvailableVastTags(settings) {
  const tags = [settings.vastTagUrl, ...(settings.fallbackVastTags || [])]
    .map(normalizeVastTagUrl)
    .filter(Boolean);
  if (!tags.length) return { vastTagUrl: '', fallbackVastTags: [], diagnostics: [] };
  if (!shouldProbeVastTags()) {
    return {
      vastTagUrl: tags[0],
      fallbackVastTags: tags.slice(1),
      diagnostics: [{ tagUrl: tags[0], ok: null, reason: 'probe_disabled' }],
    };
  }

  const diagnostics = [];
  for (let i = 0; i < tags.length; i += 1) {
    const probe = await probeVastTagAvailability(tags[i]);
    diagnostics.push(safeVastDiagnostics(probe));
    if (probe.ok) {
      return { vastTagUrl: tags[i], fallbackVastTags: tags.slice(i + 1), diagnostics };
    }
    if (probe.uncertain) {
      return { vastTagUrl: tags[i], fallbackVastTags: tags.slice(i + 1), diagnostics, probeUncertain: true };
    }
  }
  return { vastTagUrl: '', fallbackVastTags: [], diagnostics };
}

function unlockSecret() {
  return process.env.AD_UNLOCK_TOKEN_SECRET || process.env.PLAYBACK_TOKEN_SECRET || process.env.JWT_SECRET || 'change-ad-unlock-secret';
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function pruneMemoryAdSessions() {
  const now = Date.now();
  for (const [sessionId, session] of memoryAdSessions.entries()) {
    if (!session?.expires_at || new Date(session.expires_at).getTime() < now) {
      memoryAdSessions.delete(sessionId);
    }
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(str) {
  return Buffer.from(str, 'base64url');
}

export function signStreamUnlockToken({ sessionId, videoId, viewerKey, ttlSec = UNLOCK_TTL_SEC }) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSec);
  const payload = `${sessionId}:${videoId}:${viewerKey}:${exp}`;
  const sig = crypto.createHmac('sha256', unlockSecret()).update(payload).digest('base64url');
  return {
    token: `${b64url(payload)}.${sig}`,
    expiresAt: exp * 1000,
  };
}

export function verifyStreamUnlockToken(token, videoId, viewerKey) {
  if (!token || !videoId) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  try {
    const payload = fromB64url(parts[0]).toString('utf8');
    const [sid, vid, vk, expStr] = payload.split(':');
    if (vid !== videoId) return false;
    if (viewerKey && vk !== viewerKey && vk !== 'anon') return false;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const expected = crypto.createHmac('sha256', unlockSecret()).update(payload).digest('base64url');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]));
  } catch {
    return false;
  }
}

function isRecoverableNoFillDiagnostic(item) {
  if (!item) return false;
  const reason = String(item.reason || '').toLowerCase();
  if (reason === 'no_fill' || item.noFill === true) return true;
  return reason === 'empty_response' && Number(item.status) === 200;
}

function canBypassForNoFill(diagnostics = []) {
  const concrete = (diagnostics || []).filter(Boolean);
  return concrete.length > 0 && concrete.every(isRecoverableNoFillDiagnostic);
}

function createAdUnavailableUnlock({ videoId, userId, fingerprint }) {
  const viewerKey = userId || fingerprint || 'anon';
  return signStreamUnlockToken({
    sessionId: `ad_unavailable_${crypto.randomUUID()}`,
    videoId,
    viewerKey,
  });
}

async function resolveVideoMeta(videoId) {
  if (supabase) {
    try {
      const { data } = await withTimeout(
        supabase
          .from('tiktok_videos')
          .select('user_id, is_premium_content, token_price, storage_url')
          .eq('video_id', videoId)
          .maybeSingle(),
        AD_METADATA_READ_TIMEOUT_MS,
        'supabase video metadata',
      );
      if (data) {
        const tokenPrice = Number(data.token_price || 0);
        return {
          creatorId: data.user_id || null,
          isPremium: data.is_premium_content === true || tokenPrice > 0,
          tokenPrice,
          embedOnly: !data.storage_url,
        };
      }
    } catch (err) {
      console.warn('[vastAd] Supabase video metadata lookup skipped:', err?.message || err);
    }
  }
  const rtdb = getFirebaseRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(
        rtdb.ref(`videos/${videoId}`).once('value'),
        AD_METADATA_READ_TIMEOUT_MS,
        'firebase video metadata',
      );
      const val = snap.val();
      if (val) {
        const tokenPrice = Number(val.tokenPrice ?? val.coin_price ?? 0) || 0;
        const isPremium = val.isPremiumContent === true || val.isPremium === true || tokenPrice > 0;
        return {
          creatorId: val.userId || val.user_id || null,
          isPremium,
          tokenPrice,
          embedOnly: false,
        };
      }
    } catch (err) {
      console.warn('[vastAd] Firebase video metadata lookup skipped:', err?.message || err);
    }
  }
  return { creatorId: null, isPremium: false, tokenPrice: 0, embedOnly: false };
}

async function hasActiveUnlock(videoId, userId, fingerprint) {
  if (!supabase) return false;
  try {
    const now = new Date().toISOString();
    let query = supabase
      .from('video_ad_unlocks')
      .select('id')
      .eq('video_id', videoId)
      .gt('expires_at', now)
      .limit(1);
    if (userId) query = query.eq('user_id', userId);
    else if (fingerprint) query = query.eq('fingerprint', fingerprint);
    const { data, error } = await withTimeout(query.maybeSingle(), AD_METADATA_READ_TIMEOUT_MS, 'active ad unlock');
    if (error && isMissingDbFeature(error)) return false;
    if (error) return false;
    return Boolean(data?.id);
  } catch {
    return false;
  }
}

async function markPlayHistoryAdSeen(videoId, userId, fingerprint) {
  if (!supabase) return;
  try {
    if (userId) {
      const { data } = await withTimeout(
        supabase.from('video_play_history').select('id').eq('video_id', videoId).eq('user_id', userId).maybeSingle(),
        AD_METADATA_READ_TIMEOUT_MS,
        'mark user ad history lookup',
      );
      if (data?.id) {
        await withTimeout(
          supabase.from('video_play_history').update({ has_seen_ad: true, updated_at: new Date().toISOString() }).eq('id', data.id),
          AD_METADATA_READ_TIMEOUT_MS,
          'mark user ad history update',
        );
      } else {
        await withTimeout(
          supabase.from('video_play_history').insert({ video_id: videoId, user_id: userId, has_seen_ad: true }),
          AD_METADATA_READ_TIMEOUT_MS,
          'mark user ad history insert',
        );
      }
      return;
    }
    if (fingerprint) {
      const { data } = await withTimeout(
        supabase.from('video_play_history').select('id').eq('video_id', videoId).eq('session_id', fingerprint).maybeSingle(),
        AD_METADATA_READ_TIMEOUT_MS,
        'mark anonymous ad history lookup',
      );
      if (data?.id) {
        await withTimeout(
          supabase.from('video_play_history').update({ has_seen_ad: true, updated_at: new Date().toISOString() }).eq('id', data.id),
          AD_METADATA_READ_TIMEOUT_MS,
          'mark anonymous ad history update',
        );
      } else {
        await withTimeout(
          supabase.from('video_play_history').insert({ video_id: videoId, session_id: fingerprint, has_seen_ad: true }),
          AD_METADATA_READ_TIMEOUT_MS,
          'mark anonymous ad history insert',
        );
      }
    }
  } catch (err) {
    console.warn('[vastAd] ad history mark skipped:', err?.message || err);
  }
}

async function getVastSettings() {
  const enabled = true;
  const skipAfterSeconds = 5;
  const timeoutSec = 5;
  const estimatedCpmUsd = 2;
  const frequencyVideos = 1;
  const cooldownSec = 0;
  const probability = 1;

  const vastTagUrl = normalizeVastTagUrl(DEFAULT_VAST_TAG) || APPROVED_DEFAULT_VAST_TAG;
  const fallbackVastTags = [];

  return {
    enabled,
    provider: 'exoclick',
    vastTagUrl,
    fallbackVastTags,
    skipAfterSeconds,
    timeoutSec,
    estimatedCpmUsd,
    frequencyVideos,
    cooldownSec,
    probability,
  };
}

export async function shouldRequireAd({
  videoId,
  userId,
  fingerprint,
  skipAds = false,
  meta: metaOverride = null,
  settings: settingsOverride = null,
}) {
  if (skipAds) return false;
  const settings = settingsOverride || await getVastSettings();
  if (!settings.enabled) return false;

  const meta = metaOverride || await resolveVideoMeta(videoId);
  if (meta.embedOnly) return false;
  if (meta.isPremium && userId) {
    const hasAccess = await userHasPremiumAccess(userId, videoId, meta.creatorId);
    if (hasAccess) return false;
  }

  return true;
}

export async function createAdSession({ videoId, userId, fingerprint, skipAds = false }) {
  const settings = await getVastSettings();
  const meta = await resolveVideoMeta(videoId);
  const requireAd = await shouldRequireAd({ videoId, userId, fingerprint, skipAds, meta, settings });

  if (!requireAd) {
    return {
      requireAd: false,
      streamUnlockToken: null,
      skipAfterSeconds: settings.skipAfterSeconds,
      timeoutSec: settings.timeoutSec,
      adPolicy: {
        frequencyVideos: settings.frequencyVideos,
        cooldownSec: settings.cooldownSec,
        probability: settings.probability,
      },
    };
  }

  const availableVast = await resolveAvailableVastTags(settings);
  if (!availableVast.vastTagUrl) {
    if (canBypassForNoFill(availableVast.diagnostics)) {
      const signed = createAdUnavailableUnlock({ videoId, userId, fingerprint });
      console.info('[vastAd] no VAST fill; issuing temporary playback unlock', {
        videoId,
        diagnostics: availableVast.diagnostics,
      });
      return {
        requireAd: false,
        adUnavailable: true,
        adUnavailableReason: 'no_fill',
        streamUnlockToken: signed.token,
        streamUnlockExpiresAt: signed.expiresAt,
        skipAfterSeconds: settings.skipAfterSeconds,
        timeoutSec: settings.timeoutSec,
        vastDiagnostics: availableVast.diagnostics,
        adPolicy: {
          frequencyVideos: settings.frequencyVideos,
          cooldownSec: settings.cooldownSec,
          probability: settings.probability,
        },
      };
    }
    if ((availableVast.diagnostics || []).some((item) => item && item.cached !== true)) {
      console.warn('[vastAd] no playable VAST inventory; stream unlock withheld', {
        videoId,
        diagnostics: availableVast.diagnostics,
      });
    }
    const err = new Error('Advertisement unavailable. Please try again.');
    err.statusCode = 503;
    err.code = 'AD_INVENTORY_UNAVAILABLE';
    err.diagnostics = availableVast.diagnostics;
    throw err;
  }

  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
  pruneMemoryAdSessions();
  memoryAdSessions.set(sessionId, {
    id: sessionId,
    video_id: videoId,
    user_id: userId || null,
    creator_id: meta.creatorId,
    fingerprint: fingerprint || null,
    session_token_hash: hashToken(sessionToken),
    status: 'pending',
    vast_tag_url: availableVast.vastTagUrl,
    skip_after_seconds: settings.skipAfterSeconds,
    expires_at: expiresAt,
    started_at: new Date().toISOString(),
  });

  if (supabase) {
    const { error } = await withTimeout(
      supabase.from('vast_ad_sessions').insert({
        id: sessionId,
        video_id: videoId,
        user_id: userId || null,
        creator_id: meta.creatorId,
        fingerprint: fingerprint || null,
        session_token_hash: hashToken(sessionToken),
        status: 'pending',
        vast_tag_url: availableVast.vastTagUrl,
        skip_after_seconds: settings.skipAfterSeconds,
        expires_at: expiresAt,
      }),
      AD_METADATA_READ_TIMEOUT_MS,
      'create VAST session',
    ).catch((err) => {
      console.warn('[vastAd] session write skipped:', err?.message || err);
      return { error: null };
    });
    if (error && !isMissingDbFeature(error)) console.warn('[vastAd] session write failed:', error.message || error);
  }

  return {
    requireAd: true,
    sessionId,
    sessionToken,
    vastTagUrl: availableVast.vastTagUrl,
    fallbackVastTags: availableVast.fallbackVastTags || [],
    skipAfterSeconds: settings.skipAfterSeconds,
    timeoutSec: settings.timeoutSec,
    vastDiagnostics: availableVast.diagnostics,
    probeUncertain: Boolean(availableVast.probeUncertain),
    adPolicy: {
      frequencyVideos: settings.frequencyVideos,
      cooldownSec: settings.cooldownSec,
      probability: settings.probability,
    },
    expiresAt,
  };
}

async function loadSession(sessionId) {
  if (!sessionId) return null;
  pruneMemoryAdSessions();
  if (supabase) {
    const { data, error } = await withTimeout(
      supabase
        .from('vast_ad_sessions')
        .select('*')
        .eq('id', sessionId)
        .maybeSingle(),
      AD_METADATA_READ_TIMEOUT_MS,
      'load ad session',
    );
    if (data) return data;
    if (error && !isMissingDbFeature(error)) throw error;
  }
  return memoryAdSessions.get(sessionId) || null;
}

export async function recordAdEvent({ sessionId, event, metadata = {}, userId, fingerprint }) {
  const session = await loadSession(sessionId);
  if (!session) {
    const err = new Error('Ad session not found');
    err.statusCode = 404;
    err.code = 'AD_SESSION_NOT_FOUND';
    throw err;
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    const err = new Error('Ad session expired');
    err.statusCode = 410;
    throw err;
  }

  const normalized = String(event || '').toLowerCase();
  const allowed = ['requested', 'loaded', 'impression', 'started', 'complete', 'skip', 'no_fill', 'error', 'click', 'clicked', 'main_video_started', 'watch_progress', 'unsupported'];
  if (!allowed.includes(normalized)) {
    const err = new Error('Invalid ad event');
    err.statusCode = 400;
    throw err;
  }

  if (supabase) {
    await withTimeout(
      supabase.from('vast_ad_events').upsert({
        session_id: sessionId,
        event_type: normalized,
        metadata,
      }, { onConflict: 'session_id,event_type', ignoreDuplicates: true }),
      AD_METADATA_READ_TIMEOUT_MS,
      'record VAST event',
    ).catch((err) => console.warn('[vastAd] event write skipped:', err?.message || err));
  }

  let streamUnlockToken = null;
  const unlockEvents = ['complete', 'skip', 'no_fill'];
  if (unlockEvents.includes(normalized)) {
    const viewerKey = session.user_id || session.fingerprint || fingerprint || userId || 'anon';
    const signed = signStreamUnlockToken({
      sessionId,
      videoId: session.video_id,
      viewerKey,
    });
    streamUnlockToken = signed.token;
    const finalStatus = normalized === 'complete'
      ? 'completed'
      : normalized === 'skip'
        ? 'skipped'
        : 'failed';

    if (supabase) {
      await withTimeout(
        supabase.from('video_ad_unlocks').insert({
          video_id: session.video_id,
          user_id: session.user_id || userId || null,
          fingerprint: session.fingerprint || fingerprint || null,
          unlock_token_hash: hashToken(streamUnlockToken),
          session_id: sessionId,
          expires_at: new Date(Date.now() + UNLOCK_TTL_SEC * 1000).toISOString(),
        }),
        AD_METADATA_READ_TIMEOUT_MS,
        'record ad unlock',
      ).catch((err) => console.warn('[vastAd] unlock write skipped:', err?.message || err));
      await withTimeout(
        supabase.from('vast_ad_sessions').update({
          status: finalStatus,
          completed_at: new Date().toISOString(),
        }).eq('id', sessionId),
        AD_METADATA_READ_TIMEOUT_MS,
        'update VAST session',
      ).catch((err) => console.warn('[vastAd] session update skipped:', err?.message || err));
    }
    const memorySession = memoryAdSessions.get(sessionId);
    if (memorySession) {
      memoryAdSessions.set(sessionId, {
        ...memorySession,
        status: finalStatus,
        completed_at: new Date().toISOString(),
      });
    }

    if (normalized === 'complete' || normalized === 'skip') {
      await markPlayHistoryAdSeen(session.video_id, session.user_id || userId, session.fingerprint || fingerprint);
    }

    let rewardResult = { credited: false };
    if (normalized === 'complete' || normalized === 'skip') {
      rewardResult = await withTimeout(
        creditValidAdView({
          session,
          eventType: normalized,
          metadata: { ...metadata, provider: metadata.provider || 'exoclick' },
        }),
        AD_METADATA_READ_TIMEOUT_MS,
        'credit ad reward',
      ).catch((err) => {
        console.warn('[vastAd] reward credit skipped:', err?.message || err);
        return { credited: false };
      });
    }
    return {
      streamUnlockToken,
      credited: rewardResult.credited,
      rewardUsd: rewardResult.rewardUsd,
      validation: rewardResult.validation,
    };
  }

  if ((normalized === 'error' || normalized === 'unsupported') && supabase) {
    await withTimeout(
      supabase.from('vast_ad_sessions').update({
        status: 'failed',
        completed_at: new Date().toISOString(),
      }).eq('id', sessionId),
      AD_METADATA_READ_TIMEOUT_MS,
      'mark VAST session failed',
    ).catch((err) => console.warn('[vastAd] session failed update skipped:', err?.message || err));
  }
  if (normalized === 'error' || normalized === 'unsupported') {
    const memorySession = memoryAdSessions.get(sessionId);
    if (memorySession) {
      memoryAdSessions.set(sessionId, {
        ...memorySession,
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
    }
  }

  if (normalized === 'started' && supabase) {
    await withTimeout(
      supabase.from('vast_ad_sessions').update({ status: 'started' }).eq('id', sessionId),
      AD_METADATA_READ_TIMEOUT_MS,
      'mark VAST session started',
    ).catch((err) => console.warn('[vastAd] session started update skipped:', err?.message || err));
  }

  if (normalized === 'impression' && supabase) {
    await withTimeout(
      supabase.from('vast_ad_sessions').update({ status: 'started' }).eq('id', sessionId),
      AD_METADATA_READ_TIMEOUT_MS,
      'mark VAST session impression',
    ).catch((err) => console.warn('[vastAd] session impression update skipped:', err?.message || err));
  }

  return { streamUnlockToken, credited: false };
}

export async function assertAdUnlockForStream({ videoId, userId, fingerprint, adUnlockToken }) {
  const requireAd = await shouldRequireAd({ videoId, userId, fingerprint, skipAds: false });
  if (!requireAd) return true;

  const viewerKey = userId || fingerprint || 'anon';
  if (adUnlockToken && verifyStreamUnlockToken(adUnlockToken, videoId, viewerKey)) {
    return true;
  }

  if (await hasActiveUnlock(videoId, userId, fingerprint)) {
    return true;
  }

  const err = new Error('Watch the ad to unlock playback.');
  err.statusCode = 403;
  err.code = 'AD_UNLOCK_REQUIRED';
  throw err;
}

export async function getAdStatusForVideo({ videoId, userId, fingerprint }) {
  const requireAd = await shouldRequireAd({ videoId, userId, fingerprint, skipAds: false });
  const settings = await getVastSettings();
  const availableVast = requireAd ? await resolveAvailableVastTags(settings) : null;
  return {
    requireAd: requireAd && Boolean(availableVast?.vastTagUrl),
    adUnavailable: requireAd && !availableVast?.vastTagUrl,
    vastTagUrl: requireAd ? availableVast?.vastTagUrl || null : null,
    fallbackVastTags: requireAd ? availableVast?.fallbackVastTags || [] : [],
    vastDiagnostics: requireAd ? availableVast?.diagnostics || [] : [],
    skipAfterSeconds: settings.skipAfterSeconds,
    timeoutSec: settings.timeoutSec,
    adPolicy: {
      frequencyVideos: settings.frequencyVideos,
      cooldownSec: settings.cooldownSec,
      probability: settings.probability,
    },
  };
}
