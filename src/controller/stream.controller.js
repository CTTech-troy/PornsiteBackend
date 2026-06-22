import { getFirebaseRtdb } from '../config/firebase.js';
import { supabase, VIDEO_BUCKET } from '../config/supabase.js';
import { lookupHomeFeedRow } from '../config/homeFeedCache.js';
import { getVideoById as getFeedVideoById } from './videoFeed.controller.js';
import { validateVideoPlaybackSource } from '../utils/videoPlaybackValidation.js';
import {
  assertPremiumPlaybackAccess,
  signPlaybackToken,
} from '../services/playbackAccess.service.js';
import { assertAdUnlockForStream } from '../services/vastAdSession.service.js';

function normalizeStreamParam(raw) {
  let id = String(raw ?? '').trim().replace(/\/+$/, '');
  for (let i = 0; i < 4; i++) {
    try {
      const next = decodeURIComponent(id);
      if (next === id) break;
      id = next;
    } catch {
      break;
    }
  }
  try {
    id = id.normalize('NFKC');
  } catch {
    /* ignore */
  }
  return id.trim().replace(/\/+$/, '');
}

function extractPornhubViewkey(raw) {
  if (raw == null || raw === '') return null;
  const s = normalizeStreamParam(raw);
  const direct = s.match(/^ph[0-9a-f]{8,}$/i);
  if (direct) return direct[0].toLowerCase();
  const anywhere = s.match(/\b(ph[0-9a-f]{8,})\b/i);
  if (anywhere) return anywhere[1].toLowerCase();
  const vk = s.match(/[?&]viewkey=(ph[0-9a-f]{8,})/i);
  if (vk) return vk[1].toLowerCase();
  return null;
}

function playableUrlFromRecord(record) {
  const validation = validateVideoPlaybackSource(record || {});
  return validation.playable === true && validation.embedAllowed !== true
    ? validation.playbackUrl
    : '';
}

async function resolveUploadedVideoCandidate(videoId, requesterUid = null) {
  if (!supabase || !videoId) return '';
  try {
    const { data, error } = await supabase
      .from('tiktok_videos')
      .select('*')
      .eq('video_id', videoId)
      .maybeSingle();
    if (error) {
      console.warn('stream.controller uploaded lookup failed:', error?.message || error);
      return '';
    }
    if (!data) return '';

    const status = String(data.status || '').trim().toLowerCase();
    const isListed = data.is_live === true || status === 'published';
    const isOwner = requesterUid && String(data.user_id || '') === String(requesterUid);
    if (!isListed && !isOwner) return '';

    const directUrl = String(
      data.playback_url ||
      data.stream_url ||
      data.primary_url ||
      data.storage_url ||
      ''
    ).trim();
    if (!directUrl) return '';

    return playableUrlFromRecord({
      ...data,
      source: 'community',
      playback_url: directUrl,
      stream_url: directUrl,
      storage_url: data.storage_url || data.primary_url || directUrl,
      videoUrl: directUrl,
      video_url: directUrl,
      playable: true,
      validation_status: 'playable',
      source_type: data.source_type || 'approved_stream',
    });
  } catch (err) {
    console.warn('stream.controller uploaded lookup failed:', err?.message || err);
    return '';
  }
}

const SIGNED_STREAM_TTL_SEC = Math.max(30, Number(process.env.STREAM_SIGNED_URL_TTL_SEC || 120));

function parseSupabaseObjectUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    const match = parsed.pathname.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/i);
    if (!match) return null;
    return {
      bucket: decodeURIComponent(match[1]),
      path: decodeURIComponent(match[2].replace(/\+/g, ' ')),
    };
  } catch {
    return null;
  }
}

function isPlatformStorageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const parsed = parseSupabaseObjectUrl(url);
  if (parsed) return true;
  const configuredHost = (() => {
    try {
      return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname : '';
    } catch {
      return '';
    }
  })();
  if (!configuredHost) return false;
  try {
    return new URL(url).hostname === configuredHost;
  } catch {
    return false;
  }
}

async function createSignedStreamUrl(candidate) {
  const rawUrl = String(candidate || '').trim();
  if (!rawUrl) return { url: '', expiresAt: null, signed: false };
  const parsed = parseSupabaseObjectUrl(rawUrl);
  if (!parsed || !supabase) {
    return { url: rawUrl, expiresAt: null, signed: false };
  }

  const { data, error } = await supabase.storage
    .from(parsed.bucket || VIDEO_BUCKET)
    .createSignedUrl(parsed.path, SIGNED_STREAM_TTL_SEC);

  if (error || !data?.signedUrl) {
    console.warn('[stream] signed URL creation failed:', error?.message || error || parsed.path);
    return { url: rawUrl, expiresAt: null, signed: false };
  }

  return {
    url: data.signedUrl,
    expiresAt: Date.now() + (SIGNED_STREAM_TTL_SEC * 1000),
    signed: true,
  };
}

function unsupportedResponse(res) {
  return res.status(404).json({
    error: 'This video is unavailable for in-platform playback.',
    code: 'UNSUPPORTED_EXTERNAL_VIDEO',
  });
}

async function resolvePremiumMeta(videoId) {
  const rtdb = getFirebaseRtdb();
  if (rtdb) {
    const snap = await rtdb.ref(`videos/${videoId}`).once('value');
    const val = snap.val();
    if (val) {
      const tokenPrice = Number(val.tokenPrice ?? val.coin_price ?? 0) || 0;
      const isPremium =
        val.isPremiumContent === true ||
        val.is_premium_content === true ||
        val.isPremium === true ||
        tokenPrice > 0;
      return { isPremium, creatorId: val.userId || val.user_id || null, tokenPrice };
    }
  }
  if (supabase) {
    const { data } = await supabase
      .from('tiktok_videos')
      .select('user_id, is_premium_content, token_price')
      .eq('video_id', videoId)
      .maybeSingle();
    if (data) {
      const tokenPrice = Number(data.token_price || 0);
      return {
        isPremium: data.is_premium_content === true || tokenPrice > 0,
        creatorId: data.user_id,
        tokenPrice,
      };
    }
  }
  return { isPremium: false, creatorId: null, tokenPrice: 0 };
}

/**
 * GET /api/videos/stream/:id
 * Returns only pre-validated direct stream URLs (no scrapers or external redirects).
 * Premium videos require auth + verified purchase; returns short-lived playback token.
 */
export async function getStreamUrl(req, res) {
  try {
    const id = normalizeStreamParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'missing id' });

    if (extractPornhubViewkey(id)) {
      return unsupportedResponse(res);
    }

    const premiumMeta = await resolvePremiumMeta(id);
    const uid = req.uid || null;
    const playbackTokenQuery = req.query?.playbackToken || req.headers['x-playback-token'];
    const adUnlockToken = req.query?.adUnlockToken || req.headers['x-ad-unlock-token'];
    const fingerprint = req.query?.fingerprint || req.headers['x-viewer-fingerprint'] || null;

    const isOwnerViewer = uid && premiumMeta.creatorId && String(uid) === String(premiumMeta.creatorId);

    if (premiumMeta.isPremium) {
      try {
        await assertPremiumPlaybackAccess({
          userId: uid,
          videoId: id,
          creatorId: premiumMeta.creatorId,
          playbackToken: playbackTokenQuery,
        });
      } catch (accessErr) {
        return res.status(accessErr.statusCode || 403).json({
          error: accessErr.message,
          code: accessErr.code || 'PREMIUM_REQUIRED',
        });
      }
    } else if (!isOwnerViewer) {
      try {
        await assertAdUnlockForStream({
          videoId: id,
          userId: uid,
          fingerprint,
          adUnlockToken,
        });
      } catch (accessErr) {
        return res.status(accessErr.statusCode || 403).json({
          error: accessErr.message,
          code: accessErr.code || 'AD_UNLOCK_REQUIRED',
        });
      }
    }

    let candidate = '';

    try {
      const rtdb = getFirebaseRtdb();
      if (rtdb) {
        const snap = await rtdb.ref(`videos/${id}`).once('value');
        const val = snap.val();
        if (val) {
          candidate = playableUrlFromRecord(val);
        }
      }
    } catch (err) {
      console.warn('stream.controller RTDB lookup failed:', err?.message || err);
    }

    if (!candidate) {
      candidate = await resolveUploadedVideoCandidate(id, uid);
    }

    if (!candidate) {
      try {
        const feedVideo = await getFeedVideoById(id);
        if (feedVideo) {
          candidate = playableUrlFromRecord(feedVideo);
        }
      } catch (err) {
        console.warn('stream.controller feed lookup failed:', err?.message || err);
      }
    }

    if (!candidate) {
      try {
        const hf = lookupHomeFeedRow(id);
        const play = playableUrlFromRecord(hf);
        if (play) {
          candidate = play;
        }
      } catch (err) {
        console.warn('stream.controller home-feed lookup failed:', err?.message || err);
      }
    }

    if (!candidate) {
      return unsupportedResponse(res);
    }

    const signedStream = await createSignedStreamUrl(candidate);
    const payload = {
      url: signedStream.url,
      expiresAt: signedStream.expiresAt,
      signed: signedStream.signed,
      delivery: signedStream.signed || isPlatformStorageUrl(candidate) ? 'signed_url' : 'source_url',
    };
    if (premiumMeta.isPremium && uid) {
      const signed = signPlaybackToken({ userId: uid, videoId: id });
      payload.playbackToken = signed.token;
      payload.playbackTokenExpiresAt = signed.expiresAt;
      payload.premium = true;
    }

    res.set('Cache-Control', premiumMeta.isPremium ? 'private, no-store' : 'private, max-age=30, stale-while-revalidate=30');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.json(payload);
  } catch (err) {
    console.error('getStreamUrl error', err?.message || err);
    return res.status(500).json({ error: err?.message || 'failed' });
  }
}

export default { getStreamUrl };
