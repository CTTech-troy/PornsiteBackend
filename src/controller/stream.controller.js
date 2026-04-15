import { getFirebaseRtdb } from '../config/firebase.js';
import { lookupHomeFeedRow } from '../config/homeFeedCache.js';
import { getVideoById as getFeedVideoById } from './videoFeed.controller.js';

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
  const embedded = s.match(/(ph[0-9a-f]{8,})/i);
  if (embedded) return embedded[1].toLowerCase();
  return null;
}

function firstPlayableFromDownloadUrls(downloadUrls) {
  if (!downloadUrls) return null;
  if (Array.isArray(downloadUrls)) {
    for (const item of downloadUrls) {
      if (typeof item === 'string' && /^https?:\/\//i.test(item)) return item;
      if (item && typeof item === 'object') {
        const u = item.url || item.link || item.href || item.videoUrl || item.video_url;
        if (typeof u === 'string' && /^https?:\/\//i.test(u)) return u;
      }
    }
    return null;
  }
  if (typeof downloadUrls !== 'object') return null;
  for (const v of Object.values(downloadUrls)) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
    if (v && typeof v === 'object') {
      const u = v.url || v.link || v.href || v.videoUrl || v.video_url;
      if (typeof u === 'string' && /^https?:\/\//i.test(u)) return u;
    }
  }
  return null;
}

async function resolvePornhubStream(phKeyFirst, res) {
  try {
    const { getVideoInfo } = await import('../../pornhubScraper.js');
    const pageUrl = `https://www.pornhub.com/view_video.php?viewkey=${encodeURIComponent(phKeyFirst)}`;
    const info = await getVideoInfo(pageUrl);
    const fromDl = firstPlayableFromDownloadUrls(info?.download_urls);
    if (fromDl) return res.json({ url: String(fromDl) });
  } catch (err) {
    console.warn('stream.controller Pornhub lookup failed:', err?.message || err);
  }
  try {
    const { fetchPornhubDirectMp4FromWatchPage } = await import('../util/pornhubDirectFromPage.js');
    const directMp4 = await fetchPornhubDirectMp4FromWatchPage(phKeyFirst);
    if (directMp4) return res.json({ url: directMp4 });
  } catch (err) {
    console.warn('stream.controller Pornhub page extract failed:', err?.message || err);
  }
  const watchUrl = `https://www.pornhub.com/view_video.php?viewkey=${encodeURIComponent(phKeyFirst)}`;
  return res.json({ url: watchUrl, kind: 'pornhub_watch' });
}

/**
 * GET /api/videos/stream/:id
 * RTDB uploads first, then Pornhub viewkeys, then feed / home-feed.
 */
export async function getStreamUrl(req, res) {
  try {
    const id = normalizeStreamParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'missing id' });

    try {
      const rtdb = getFirebaseRtdb();
      if (rtdb) {
        const snap = await rtdb.ref(`videos/${id}`).once('value');
        const val = snap.val();
        if (val) {
          const candidate = val.streamUrl || val.videoUrl || val.video_url || val.stream_url || val.storage_url || null;
          if (candidate) return res.json({ url: String(candidate) });
        }
      }
    } catch (err) {
      console.warn('stream.controller RTDB lookup failed:', err?.message || err);
    }

    const phKey = extractPornhubViewkey(id);
    if (phKey) {
      await resolvePornhubStream(phKey, res);
      return;
    }

    try {
      const feedVideo = await getFeedVideoById(id);
      if (feedVideo) {
        const candidate = feedVideo.videoUrl || feedVideo.video_url || feedVideo.url || null;
        if (candidate) return res.json({ url: String(candidate) });
      }
    } catch (err) {
      console.warn('stream.controller feed lookup failed:', err?.message || err);
    }

    try {
      const hf = lookupHomeFeedRow(id);
      const play = hf && (hf.videoSrc || hf.url);
      if (play && String(play).startsWith('http')) {
        return res.json({ url: String(play) });
      }
    } catch (err) {
      console.warn('stream.controller home-feed lookup failed:', err?.message || err);
    }

    return res.status(404).json({ error: 'No playable stream found' });
  } catch (err) {
    console.error('getStreamUrl error', err?.message || err);
    return res.status(500).json({ error: err?.message || 'failed' });
  }
}

export default { getStreamUrl };
