/**
 * Like/comment for any video by id (external API id or upload id).
 * Uses same RTDB refs: videos/{id}, likes/{id}/{uid}, comments/{id}/{commentId}.
 * Ensures external ref exists (externalId, totalLikes, totalComments) when missing.
 */
import crypto from 'crypto';
import { rtdb } from '../config/firebase.js';

function videosRef() {
  return rtdb.ref('videos');
}
function likesRef() {
  return rtdb.ref('likes');
}
function commentsRef() {
  return rtdb.ref('comments');
}

const INVALID_PATH_CHARS = /[.#$\[\]]/;
function isValidPathSegment(s) {
  return typeof s === 'string' && s.length > 0 && !INVALID_PATH_CHARS.test(s);
}

async function ensureVideoRef(videoId) {
  if (!isValidPathSegment(videoId)) {
    throw new Error('invalid videoId');
  }
  const ref = videosRef().child(videoId);
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
    const uid = req.uid;
    if (!uid || !isValidPathSegment(uid)) return res.status(401).json({ error: 'Authentication required' });
    const { videoId } = req.params;
    if (!isValidPathSegment(videoId)) return res.status(400).json({ error: 'videoId required' });

    await ensureVideoRef(videoId);
    const videoSnap = await videosRef().child(videoId).once('value');
    const video = videoSnap.val();

    const likeSnap = await likesRef().child(videoId).child(uid).once('value');
    if (likeSnap.val()) {
      return res.json({ liked: true, totalLikes: video?.totalLikes ?? 0 });
    }

    await likesRef().child(videoId).child(uid).set(true);
    const newTotal = (video?.totalLikes ?? 0) + 1;
    await videosRef().child(videoId).child('totalLikes').set(newTotal);
    return res.json({ liked: true, totalLikes: newTotal });
  } catch (err) {
    console.error('videoInteractions.likeVideo', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

export async function unlikeVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid || !isValidPathSegment(uid)) return res.status(401).json({ error: 'Authentication required' });
    const { videoId } = req.params;
    if (!isValidPathSegment(videoId)) return res.status(400).json({ error: 'videoId required' });

    const videoSnap = await videosRef().child(videoId).once('value');
    const video = videoSnap.val();
    if (!video) return res.json({ liked: false, totalLikes: 0 });

    await likesRef().child(videoId).child(uid).remove();
    const newTotal = Math.max(0, (video.totalLikes ?? 0) - 1);
    await videosRef().child(videoId).child('totalLikes').set(newTotal);
    return res.json({ liked: false, totalLikes: newTotal });
  } catch (err) {
    console.error('videoInteractions.unlikeVideo', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

export async function getComments(req, res) {
  try {
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
    const uid = req.uid;
    if (!uid || !isValidPathSegment(uid)) return res.status(401).json({ error: 'Authentication required' });
    const { videoId } = req.params;
    const text = (req.body?.text || '').trim();
    if (!isValidPathSegment(videoId)) return res.status(400).json({ error: 'videoId required' });
    if (!text) return res.status(400).json({ error: 'Comment text is required' });

    const { totalComments } = await ensureVideoRef(videoId);
    const commentId = crypto.randomUUID();
    const comment = {
      userId: uid,
      text,
      createdAt: Date.now(),
    };
    await commentsRef().child(videoId).child(commentId).set(comment);
    const newTotal = (totalComments ?? 0) + 1;
    await videosRef().child(videoId).child('totalComments').set(newTotal);
    return res.status(201).json({ comment: { ...comment, commentId }, totalComments: newTotal });
  } catch (err) {
    console.error('videoInteractions.addComment', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}
