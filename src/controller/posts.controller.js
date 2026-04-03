import { rtdb } from '../config/firebase.js';
import { mergeCreatorIntoPublicVideo } from '../utils/creatorProfile.js';

function videosRef() {
  return rtdb.ref('videos');
}

/**
 * GET /api/posts?userId=...
 * Owner (Bearer uid === userId) sees all videos including drafts.
 * Others only see published (isLive === true).
 */
export async function listPosts(req, res) {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId required', data: [] });
    }
    const requesterUid = req.uid;
    const isOwner = Boolean(requesterUid && requesterUid === userId);

    const snap = await videosRef().once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') {
      return res.json({ success: true, data: [] });
    }

    let list = Object.entries(val)
      .map(([videoId, v]) => ({
        ...(typeof v === 'object' && v ? v : {}),
        videoId,
        id: videoId,
      }))
      .filter((row) => row.userId === userId);

    if (!isOwner) {
      list = list.filter((row) => row.isLive === true);
    }

    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const enriched = await Promise.all(list.map((row) => mergeCreatorIntoPublicVideo(row)));
    return res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('posts.listPosts error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed', data: [] });
  }
}
