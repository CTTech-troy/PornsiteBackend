import { rtdb } from '../config/firebase.js';
import { getVideoById as getFeedVideoById } from './videoFeed.controller.js';

/**
 * GET /api/videos/stream/:id
 * Try RTDB first (uploaded videos), then fallback to feed lookup for external videos.
 * Returns JSON { url: string } on success.
 */
export async function getStreamUrl(req, res) {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing id' });

    // 1) RTDB check for uploaded videos (has streamUrl or videoUrl)
    try {
      const snap = await rtdb.ref(`videos/${id}`).once('value');
      const val = snap.val();
      if (val) {
        const candidate = val.streamUrl || val.videoUrl || val.video_url || val.stream_url || null;
        if (candidate) return res.json({ url: String(candidate) });
      }
    } catch (err) {
      // ignore RTDB read errors and continue to feed lookup
      console.warn('stream.controller RTDB lookup failed:', err?.message || err);
    }

    // 2) Feed lookup (external sources normalized by videoFeed)
    try {
      const feedVideo = await getFeedVideoById(id);
      if (feedVideo) {
        const candidate = feedVideo.videoUrl || feedVideo.video_url || feedVideo.url || null;
        if (candidate) return res.json({ url: String(candidate) });
      }
    } catch (err) {
      console.warn('stream.controller feed lookup failed:', err?.message || err);
    }

    return res.status(404).json({ error: 'No playable stream found' });
  } catch (err) {
    console.error('getStreamUrl error', err?.message || err);
    return res.status(500).json({ error: err?.message || 'failed' });
  }
}

export default { getStreamUrl };
