/**
 * Like/comment for any video by id (external API id or upload id).
 * Uses same RTDB refs: videos/{id}, likes/{id}/{uid}, comments/{id}/{commentId}.
 * Ensures external ref exists (externalId, totalLikes, totalComments) when missing.
 */
import crypto from 'crypto';
import { getFirebaseRtdb } from '../config/firebase.js';

function videosRef() {
  const rtdb = getFirebaseRtdb();
  return rtdb ? rtdb.ref('videos') : null;
}
function likesRef() {
  const rtdb = getFirebaseRtdb();
  return rtdb ? rtdb.ref('likes') : null;
}
function commentsRef() {
  const rtdb = getFirebaseRtdb();
  return rtdb ? rtdb.ref('comments') : null;
}

const INVALID_PATH_CHARS = /[.#$\[\]]/;
function isValidPathSegment(s) {
  return typeof s === 'string' && s.length > 0 && !INVALID_PATH_CHARS.test(s);
}

async function ensureVideoRef(videoId) {
  if (!isValidPathSegment(videoId)) {
    throw new Error('invalid videoId');
  }
  const root = videosRef();
  if (!root) {
    throw new Error('RTDB_UNAVAILABLE');
  }
  const ref = root.child(videoId);
  const snap = await ref.once('value');
  const val = snap.val();
  if (!val) {
    await ref.set({ externalId: String(videoId), totalLikes: 0, totalComments: 0 });
    return { totalLikes: 0, totalComments: 0 };
  }
  return { totalLikes: val.totalLikes ?? 0, totalComments: val.totalComments ?? 0 };
}

export async function getLikeStatus(req, res) {
  try {
    if (!videosRef() || !likesRef()) {
      return res.json({ liked: false, totalLikes: 0, totalComments: 0 });
    }
    const uid = req.uid;
    const { videoId } = req.params;
    if (!isValidPathSegment(videoId)) {
      return res.json({ liked: false, totalLikes: 0, totalComments: 0 });
    }
    let totalLikes = 0;
    let totalComments = 0;
    const videoSnap = await videosRef().child(videoId).once('value');
    const videoVal = videoSnap.val();
    if (videoVal) {
      totalLikes = videoVal.totalLikes ?? 0;
      totalComments = videoVal.totalComments ?? 0;
    }
    if (!uid || !isValidPathSegment(uid)) {
      return res.json({ liked: false, totalLikes, totalComments });
    }
    const snap = await likesRef().child(videoId).child(uid).once('value');
    return res.json({ liked: !!snap.val(), totalLikes, totalComments });
  } catch (err) {
    console.error('videoInteractions.getLikeStatus', err?.message || err);
    return res.json({ liked: false, totalLikes: 0, totalComments: 0 });
  }
}

export async function likeVideo(req, res) {
  try {
    if (!videosRef() || !likesRef()) {
      return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });
    }
    const uid = req.uid;
    if (!uid || !isValidPathSegment(uid)) return res.status(401).json({ error: 'Authentication required' });
    const { videoId } = req.params;
    if (!isValidPathSegment(videoId)) return res.status(400).json({ error: 'videoId required' });

    await ensureVideoRef(videoId);

    const likeSnap = await likesRef().child(videoId).child(uid).once('value');
    if (likeSnap.val()) {
      const videoSnap = await videosRef().child(videoId).once('value');
      return res.json({ liked: true, totalLikes: videoSnap.val()?.totalLikes ?? 0 });
    }

    await likesRef().child(videoId).child(uid).set(true);
    // BUG-03: Use RTDB transaction for atomic increment
    const result = await videosRef().child(videoId).child('totalLikes').transaction(current => (current || 0) + 1);
    return res.json({ liked: true, totalLikes: result.snapshot.val() });
  } catch (err) {
    if (err?.message === 'RTDB_UNAVAILABLE') {
      return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });
    }
    console.error('videoInteractions.likeVideo', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

export async function unlikeVideo(req, res) {
  try {
    if (!videosRef() || !likesRef()) {
      return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });
    }
    const uid = req.uid;
    if (!uid || !isValidPathSegment(uid)) return res.status(401).json({ error: 'Authentication required' });
    const { videoId } = req.params;
    if (!isValidPathSegment(videoId)) return res.status(400).json({ error: 'videoId required' });

    const videoSnap = await videosRef().child(videoId).once('value');
    const video = videoSnap.val();
    if (!video) return res.json({ liked: false, totalLikes: 0 });

    await likesRef().child(videoId).child(uid).remove();
    // BUG-03: Use RTDB transaction for atomic decrement (min 0)
    const result = await videosRef().child(videoId).child('totalLikes').transaction(current => Math.max(0, (current || 0) - 1));
    return res.json({ liked: false, totalLikes: result.snapshot.val() });
  } catch (err) {
    console.error('videoInteractions.unlikeVideo', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

export async function getComments(req, res) {
  try {
    if (!videosRef() || !commentsRef()) {
      return res.json({ data: [] });
    }
    const { videoId } = req.params;
    if (!isValidPathSegment(videoId)) return res.status(400).json({ error: 'videoId required' });

    await ensureVideoRef(videoId);
    const snap = await commentsRef().child(videoId).once('value');
    const val = snap.val();
    const list = !val ? [] : Object.entries(val).map(([id, c]) => ({ ...c, commentId: id })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return res.json({ data: list });
  } catch (err) {
    console.error('videoInteractions.getComments', err?.message || err);
    return res.status(500).json({ data: [] });
  }
}

export async function addComment(req, res) {
  try {
    if (!videosRef() || !commentsRef()) {
      return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });
    }
    const uid = req.uid;
    if (!uid || !isValidPathSegment(uid)) return res.status(401).json({ error: 'Authentication required' });
    const { videoId } = req.params;
    const text = (req.body?.text || '').trim();
    if (!isValidPathSegment(videoId)) return res.status(400).json({ error: 'videoId required' });
    if (!text) return res.status(400).json({ error: 'Comment text is required' });

    const authorName = String(req.body?.authorName || '').trim().slice(0, 64) || 'Member';

    await ensureVideoRef(videoId);
    const commentId = crypto.randomUUID();
    const comment = {
      userId: uid,
      authorName,
      text,
      createdAt: Date.now(),
    };
    await commentsRef().child(videoId).child(commentId).set(comment);
    // BUG-03: Use RTDB transaction for atomic increment
    const result = await videosRef().child(videoId).child('totalComments').transaction(current => (current || 0) + 1);
    return res.status(201).json({ comment: { ...comment, commentId }, totalComments: result.snapshot.val() });
  } catch (err) {
    console.error('videoInteractions.addComment', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

/**
 * POST /api/videos/public/:videoId/view
 * Records a video view with deduplication. Requires sessionId in body.
 * Optional auth: if user is authenticated, uid is used as dedup key instead.
 * Only counts once per session per user/sessionId pair.
 */
export async function recordPublicVideoView(req, res) {
  try {
    const { videoId } = req.params;
    if (!isValidPathSegment(videoId)) {
      return res.status(400).json({ error: 'videoId required' });
    }

    const rtdb = getFirebaseRtdb();
    if (!rtdb) {
      return res.json({ success: true, views: 0 });
    }

    const sessionId = String(req.body?.sessionId || '').trim();
    const uid = req.uid || null;

    const rawKey = uid || sessionId;
    if (!rawKey) {
      return res.status(400).json({ error: 'sessionId required' });
    }

    const dedupKey = rawKey.replace(/[.#$[\]/]/g, '_').slice(0, 128);
    const viewedRef = rtdb.ref(`videoViews/${videoId}/${dedupKey}`);
    const snap = await viewedRef.once('value');

    if (snap.val()) {
      const totalSnap = await rtdb.ref(`videos/${videoId}/totalViews`).once('value');
      return res.json({ success: true, views: Number(totalSnap.val()) || 0, duplicate: true });
    }

    await viewedRef.set(Date.now());
    await ensureVideoRef(videoId);
    const result = await rtdb.ref(`videos/${videoId}/totalViews`).transaction(
      current => (Number(current) || 0) + 1
    );

    return res.json({ success: true, views: result.snapshot.val() || 0 });
  } catch (err) {
    console.error('videoInteractions.recordPublicVideoView', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}
