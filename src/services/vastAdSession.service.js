import crypto from 'crypto';
import { supabase } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';
import { getPlatformSettingsMap } from './platformSettings.service.js';
import { resolveActiveProviders } from './adProvider.service.js';
import { isMissingDbFeature } from './revenueCalculation.service.js';
import { creditValidAdView } from './creatorAdReward.service.js';
import { userHasPremiumAccess } from './playbackAccess.service.js';

const SESSION_TTL_SEC = Number(process.env.VAST_AD_SESSION_TTL_SEC) || 600;
const UNLOCK_TTL_SEC = Number(process.env.VAST_AD_UNLOCK_TTL_SEC) || 600;
const APPROVED_DEFAULT_VAST_TAG = 'https://s.magsrv.com/v1/vast.php?idzone=5933056';
const LEGACY_DEFAULT_VAST_TAG = 'https://s.magsrv.com/v1/vast.php?idzone=5932212';
const DEFAULT_VAST_TAG = process.env.EXOCLICK_VAST_TAG_URL
  || APPROVED_DEFAULT_VAST_TAG;

function normalizeVastTagUrl(url) {
  const value = String(url || '').trim();
  return value === LEGACY_DEFAULT_VAST_TAG ? APPROVED_DEFAULT_VAST_TAG : value;
}

function unlockSecret() {
  return process.env.AD_UNLOCK_TOKEN_SECRET || process.env.PLAYBACK_TOKEN_SECRET || process.env.JWT_SECRET || 'change-ad-unlock-secret';
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
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

async function resolveVideoMeta(videoId) {
  const rtdb = getFirebaseRtdb();
  if (rtdb) {
    const snap = await rtdb.ref(`videos/${videoId}`).once('value');
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
  }
  if (supabase) {
    const { data } = await supabase
      .from('tiktok_videos')
      .select('user_id, is_premium_content, token_price, storage_url')
      .eq('video_id', videoId)
      .maybeSingle();
    if (data) {
      const tokenPrice = Number(data.token_price || 0);
      return {
        creatorId: data.user_id || null,
        isPremium: data.is_premium_content === true || tokenPrice > 0,
        tokenPrice,
        embedOnly: !data.storage_url,
      };
    }
  }
  return { creatorId: null, isPremium: false, tokenPrice: 0, embedOnly: false };
}

async function hasActiveUnlock(videoId, userId, fingerprint) {
  if (!supabase) return false;
  const now = new Date().toISOString();
  let query = supabase
    .from('video_ad_unlocks')
    .select('id')
    .eq('video_id', videoId)
    .gt('expires_at', now)
    .limit(1);
  if (userId) query = query.eq('user_id', userId);
  else if (fingerprint) query = query.eq('fingerprint', fingerprint);
  const { data, error } = await query.maybeSingle();
  if (error && isMissingDbFeature(error)) return false;
  return Boolean(data?.id);
}

async function markPlayHistoryAdSeen(videoId, userId, fingerprint) {
  if (!supabase) return;
  if (userId) {
    const { data } = await supabase.from('video_play_history').select('id').eq('video_id', videoId).eq('user_id', userId).maybeSingle();
    if (data?.id) {
      await supabase.from('video_play_history').update({ has_seen_ad: true, updated_at: new Date().toISOString() }).eq('id', data.id);
    } else {
      await supabase.from('video_play_history').insert({ video_id: videoId, user_id: userId, has_seen_ad: true });
    }
    return;
  }
  if (fingerprint) {
    const { data } = await supabase.from('video_play_history').select('id').eq('video_id', videoId).eq('session_id', fingerprint).maybeSingle();
    if (data?.id) {
      await supabase.from('video_play_history').update({ has_seen_ad: true, updated_at: new Date().toISOString() }).eq('id', data.id);
    } else {
      await supabase.from('video_play_history').insert({ video_id: videoId, session_id: fingerprint, has_seen_ad: true });
    }
  }
}

function clampProbability(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

async function hasSeenAdForVideo(videoId, userId, fingerprint) {
  if (!supabase || !videoId) return false;
  try {
    let query = supabase
      .from('video_play_history')
      .select('has_seen_ad')
      .eq('video_id', videoId);
    if (userId) query = query.eq('user_id', userId);
    else if (fingerprint) query = query.eq('session_id', fingerprint);
    else return false;
    const { data, error } = await query.maybeSingle();
    if (error && isMissingDbFeature(error)) return false;
    if (error) return false;
    return data?.has_seen_ad === true;
  } catch {
    return false;
  }
}

async function getLastViewerAdSession(userId, fingerprint) {
  if (!supabase || (!userId && !fingerprint)) return null;
  try {
    let query = supabase
      .from('vast_ad_sessions')
      .select('id, video_id, started_at, completed_at, status')
      .order('started_at', { ascending: false })
      .limit(1);
    if (userId) query = query.eq('user_id', userId);
    else query = query.eq('fingerprint', fingerprint);
    const { data, error } = await query.maybeSingle();
    if (error && isMissingDbFeature(error)) return null;
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

async function countViewerPlaysSince({ userId, fingerprint, sinceIso }) {
  if (!supabase || !sinceIso || (!userId && !fingerprint)) return null;
  try {
    let query = supabase
      .from('video_play_history')
      .select('video_id', { count: 'exact', head: true })
      .gte('updated_at', sinceIso);
    if (userId) query = query.eq('user_id', userId);
    else query = query.eq('session_id', fingerprint);
    const { count, error } = await query;
    if (error && isMissingDbFeature(error)) return null;
    if (error) return null;
    return Number(count) || 0;
  } catch {
    return null;
  }
}

async function getVastSettings() {
  const map = await getPlatformSettingsMap();
  const enabled = map.ad_revenue_enabled !== 'false' && map.ad_preroll_enabled !== 'false';
  const skipAfterSeconds = Math.max(0, Number(map.vast_skip_after_seconds_default) || 5);
  const timeoutSec = Math.max(3, Number(map.vast_ad_timeout_sec) || 8);
  const estimatedCpmUsd = Math.max(0, Number(map.vast_estimated_cpm_usd) || 2);
  const frequencyVideos = Math.max(1, Number(map.ad_preroll_frequency_videos) || 3);
  const cooldownSec = Math.max(0, Number(map.ad_preroll_cooldown_seconds) || 600);
  const probability = clampProbability(map.ad_preroll_probability ?? 1);

  let vastTagUrl = normalizeVastTagUrl(map.exoclick_vast_tag_url || DEFAULT_VAST_TAG);
  let fallbackVastTags = [];

  try {
    const { providers } = await resolveActiveProviders({ type: 'vast', placement: 'video_preroll' });
    const tags = providers
      .flatMap((p) => (p.zones || []).map((z) => z.tag_url).filter(Boolean))
      .filter(Boolean);
    if (tags.length) {
      vastTagUrl = normalizeVastTagUrl(tags[0]);
      fallbackVastTags = tags.slice(1).map(normalizeVastTagUrl);
    }
  } catch {
    /* use platform default */
  }

  return {
    enabled,
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

export async function shouldRequireAd({ videoId, userId, fingerprint, skipAds = false }) {
  if (skipAds) return false;
  const settings = await getVastSettings();
  if (!settings.enabled) return false;

  const meta = await resolveVideoMeta(videoId);
  if (meta.embedOnly) return false;
  if (meta.isPremium && userId) {
    const hasAccess = await userHasPremiumAccess(userId, videoId, meta.creatorId);
    if (hasAccess) return false;
  }

  if (await hasActiveUnlock(videoId, userId, fingerprint)) return false;

  if (await hasSeenAdForVideo(videoId, userId, fingerprint)) return false;

  if (settings.probability <= 0) return false;
  if (settings.probability < 1 && Math.random() > settings.probability) return false;

  const lastSession = await getLastViewerAdSession(userId, fingerprint);
  if (!lastSession) return true;

  const lastAt = new Date(lastSession.completed_at || lastSession.started_at).getTime();
  const hasCooldownRule = settings.cooldownSec > 0;
  const cooldownReady = hasCooldownRule && Number.isFinite(lastAt)
    ? ((Date.now() - lastAt) / 1000) >= settings.cooldownSec
    : false;

  const playsSince = await countViewerPlaysSince({
    userId,
    fingerprint,
    sinceIso: lastSession.completed_at || lastSession.started_at,
  });
  const frequencyReady = playsSince == null ? false : playsSince >= settings.frequencyVideos;
  if (!cooldownReady && !frequencyReady) {
    if (playsSince == null && !hasCooldownRule) return true;
    return false;
  }

  return true;
}

export async function createAdSession({ videoId, userId, fingerprint, skipAds = false }) {
  const settings = await getVastSettings();
  const meta = await resolveVideoMeta(videoId);
  const requireAd = await shouldRequireAd({ videoId, userId, fingerprint, skipAds });

  if (!requireAd) {
    let streamUnlockToken = null;
    if (!skipAds) {
      const viewerKey = userId || fingerprint || 'anon';
      const signed = signStreamUnlockToken({
        sessionId: 'bypass',
        videoId,
        viewerKey,
      });
      streamUnlockToken = signed.token;
    }
    return {
      requireAd: false,
      streamUnlockToken,
      skipAfterSeconds: settings.skipAfterSeconds,
      timeoutSec: settings.timeoutSec,
      adPolicy: {
        frequencyVideos: settings.frequencyVideos,
        cooldownSec: settings.cooldownSec,
        probability: settings.probability,
      },
    };
  }

  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();

  if (supabase) {
    const { error } = await supabase.from('vast_ad_sessions').insert({
      id: sessionId,
      video_id: videoId,
      user_id: userId || null,
      creator_id: meta.creatorId,
      fingerprint: fingerprint || null,
      session_token_hash: hashToken(sessionToken),
      status: 'pending',
      vast_tag_url: settings.vastTagUrl,
      skip_after_seconds: settings.skipAfterSeconds,
      expires_at: expiresAt,
    });
    if (error && !isMissingDbFeature(error)) throw error;
  }

  return {
    requireAd: true,
    sessionId,
    sessionToken,
    vastTagUrl: settings.vastTagUrl,
    fallbackVastTags: settings.fallbackVastTags || [],
    skipAfterSeconds: settings.skipAfterSeconds,
    timeoutSec: settings.timeoutSec,
    adPolicy: {
      frequencyVideos: settings.frequencyVideos,
      cooldownSec: settings.cooldownSec,
      probability: settings.probability,
    },
    expiresAt,
  };
}

async function loadSession(sessionId) {
  if (!supabase || !sessionId) return null;
  const { data, error } = await supabase
    .from('vast_ad_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();
  if (error && isMissingDbFeature(error)) return null;
  if (error) throw error;
  return data;
}

export async function recordAdEvent({ sessionId, event, metadata = {}, userId, fingerprint }) {
  const session = await loadSession(sessionId);
  if (!session) {
    const viewerKey = userId || fingerprint || 'anon';
    const signed = signStreamUnlockToken({ sessionId: sessionId || 'fallback', videoId: metadata.videoId || '', viewerKey });
    return { streamUnlockToken: signed.token, credited: false };
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    const err = new Error('Ad session expired');
    err.statusCode = 410;
    throw err;
  }

  const normalized = String(event || '').toLowerCase();
  const allowed = ['impression', 'started', 'complete', 'skip', 'error', 'click', 'watch_progress', 'unsupported'];
  if (!allowed.includes(normalized)) {
    const err = new Error('Invalid ad event');
    err.statusCode = 400;
    throw err;
  }

  if (supabase) {
    await supabase.from('vast_ad_events').upsert({
      session_id: sessionId,
      event_type: normalized,
      metadata,
    }, { onConflict: 'session_id,event_type', ignoreDuplicates: true });
  }

  let streamUnlockToken = null;
  const unlockEvents = ['complete', 'skip', 'error', 'unsupported'];
  if (unlockEvents.includes(normalized)) {
    const viewerKey = session.user_id || session.fingerprint || fingerprint || userId || 'anon';
    const signed = signStreamUnlockToken({
      sessionId,
      videoId: session.video_id,
      viewerKey,
    });
    streamUnlockToken = signed.token;

    if (supabase) {
      await supabase.from('video_ad_unlocks').insert({
        video_id: session.video_id,
        user_id: session.user_id || userId || null,
        fingerprint: session.fingerprint || fingerprint || null,
        unlock_token_hash: hashToken(streamUnlockToken),
        session_id: sessionId,
        expires_at: new Date(Date.now() + UNLOCK_TTL_SEC * 1000).toISOString(),
      });
      await supabase.from('vast_ad_sessions').update({
        status: normalized === 'complete' ? 'completed' : normalized === 'skip' ? 'skipped' : 'failed',
        completed_at: new Date().toISOString(),
      }).eq('id', sessionId);
    }

    await markPlayHistoryAdSeen(session.video_id, session.user_id || userId, session.fingerprint || fingerprint);

    let rewardResult = { credited: false };
    if (normalized === 'complete' || normalized === 'skip') {
      rewardResult = await creditValidAdView({
        session,
        eventType: normalized,
        metadata: { ...metadata, provider: metadata.provider || 'exoclick' },
      });
    }
    return {
      streamUnlockToken,
      credited: rewardResult.credited,
      rewardUsd: rewardResult.rewardUsd,
      validation: rewardResult.validation,
    };
  }

  if (normalized === 'started' && supabase) {
    await supabase.from('vast_ad_sessions').update({ status: 'started' }).eq('id', sessionId);
  }

  if (normalized === 'impression' && supabase) {
    await supabase.from('vast_ad_sessions').update({ status: 'started' }).eq('id', sessionId);
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
  return {
    requireAd,
    vastTagUrl: requireAd ? settings.vastTagUrl : null,
    skipAfterSeconds: settings.skipAfterSeconds,
    timeoutSec: settings.timeoutSec,
    adPolicy: {
      frequencyVideos: settings.frequencyVideos,
      cooldownSec: settings.cooldownSec,
      probability: settings.probability,
    },
  };
}
