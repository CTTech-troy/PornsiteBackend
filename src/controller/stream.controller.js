import { getFirebaseRtdb } from '../config/firebase.js';
import { supabase } from '../config/supabase.js';
import { lookupHomeFeedRow } from '../config/homeFeedCache.js';
import { getVideoById as getFeedVideoById } from './videoFeed.controller.js';
import { validateVideoPlaybackSource } from '../utils/videoPlaybackValidation.js';
import {
  assertPremiumPlaybackAccess,
  signPlaybackToken,
} from '../services/playbackAccess.service.js';

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

    const payload = { url: String(candidate) };
    if (premiumMeta.isPremium && uid) {
      const signed = signPlaybackToken({ userId: uid, videoId: id });
      payload.playbackToken = signed.token;
      payload.expiresAt = signed.expiresAt;
      payload.premium = true;
    }

    return res.json(payload);
  } catch (err) {
    console.error('getStreamUrl error', err?.message || err);
    return res.status(500).json({ error: err?.message || 'failed' });
  }
}

export default { getStreamUrl };
