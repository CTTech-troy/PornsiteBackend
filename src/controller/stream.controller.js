import { getFirebaseRtdb } from '../config/firebase.js';
import { lookupHomeFeedRow } from '../config/homeFeedCache.js';
import { getVideoById as getFeedVideoById } from './videoFeed.controller.js';
import { validateVideoPlaybackSource } from '../utils/videoPlaybackValidation.js';

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

/**
 * GET /api/videos/stream/:id
 * Returns only pre-validated direct stream URLs (no scrapers or external redirects).
 */
export async function getStreamUrl(req, res) {
  try {
    const id = normalizeStreamParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'missing id' });

    if (extractPornhubViewkey(id)) {
      return unsupportedResponse(res);
    }

    try {
      const rtdb = getFirebaseRtdb();
      if (rtdb) {
        const snap = await rtdb.ref(`videos/${id}`).once('value');
        const val = snap.val();
        if (val) {
          const candidate = playableUrlFromRecord(val);
          if (candidate) return res.json({ url: String(candidate) });
        }
      }
    } catch (err) {
      console.warn('stream.controller RTDB lookup failed:', err?.message || err);
    }

    try {
      const feedVideo = await getFeedVideoById(id);
      if (feedVideo) {
        const candidate = playableUrlFromRecord(feedVideo);
        if (candidate) return res.json({ url: String(candidate) });
      }
    } catch (err) {
      console.warn('stream.controller feed lookup failed:', err?.message || err);
    }

    try {
      const hf = lookupHomeFeedRow(id);
      const play = playableUrlFromRecord(hf);
      if (play) {
        return res.json({ url: String(play) });
      }
    } catch (err) {
      console.warn('stream.controller home-feed lookup failed:', err?.message || err);
    }

    return unsupportedResponse(res);
  } catch (err) {
    console.error('getStreamUrl error', err?.message || err);
    return res.status(500).json({ error: err?.message || 'failed' });
  }
}

export default { getStreamUrl };
