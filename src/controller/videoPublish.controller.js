/**
 * Secure video upload & publish: Supabase Storage + Firebase RTDB.
 * Consent required; only consentGiven === true sets isLive. Public feed returns only isLive === true.
 */
import { rtdb } from '../config/firebase.js';
import { getCreatorPublicFields, mergeCreatorIntoPublicVideo } from '../utils/creatorProfile.js';
import { uploadFileToBucket, getPublicUrl, VIDEO_BUCKET, IMAGE_BUCKET, isConfigured as isSupabaseConfigured } from '../config/supabase.js';
import crypto from 'crypto';

const CONSENT_QUESTION = 'Do you confirm you have permission to post this video?';

function videosRef() {
  return rtdb.ref('videos');
}
function likesRef() {
  return rtdb.ref('likes');
}
function commentsRef() {
  return rtdb.ref('comments');
}

/**
 * Upload video to Supabase Storage and save metadata to RTDB.
 * req.uid from auth middleware; req.file from multer; body: title, description, consentGiven.
 */
export async function uploadAndPublish(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });

    const file = req.file;
    const title = (req.body?.title || '').trim();
    const description = (req.body?.description || '').trim();
    const consentGiven = req.body?.consentGiven === true || req.body?.consentGiven === 'true';

    if (!title) return res.status(400).json({ success: false, message: 'Title is required' });
    if (!description) return res.status(400).json({ success: false, message: 'Description is required' });
    if (!file) return res.status(400).json({ success: false, message: 'Video file is required' });
    if (req.body?.consentGiven === undefined && req.body?.consentGiven !== false)
      return res.status(400).json({ success: false, message: 'You must answer the consent question' });

    const rawDur = req.body?.durationSeconds ?? req.body?.duration;
    let durationSeconds = 0;
    if (rawDur != null && String(rawDur).trim() !== '') {
      const n = parseInt(String(rawDur), 10);
      if (!Number.isNaN(n) && n >= 0) durationSeconds = Math.min(n, 86400 * 48);
    }

    const videoId = crypto.randomUUID();
    const timestamp = Date.now();
    const safeName = (file.originalname || 'video').replace(/[^a-zA-Z0-9.-]/g, '_');
    const storagePath = `${uid}/${timestamp}-${safeName}`;

    let videoUrl = null;
    if (isSupabaseConfigured()) {
      const data = await uploadFileToBucket(VIDEO_BUCKET, storagePath, file, file.mimetype || 'video/mp4');
      videoUrl = getPublicUrl(VIDEO_BUCKET, data.path) || `${process.env.SUPABASE_URL?.replace(/\/$/, '')}/storage/v1/object/public/${VIDEO_BUCKET}/${storagePath}`;
    } else {
      return res.status(503).json({ success: false, message: 'Storage not configured' });
    }

    let thumbnailUrl = null;
    const thumbFile = req.thumbnailFile;
    if (thumbFile?.buffer?.length > 0 && isSupabaseConfigured()) {
      const thumbPath = `${uid}/${timestamp}-thumb.jpg`;
      const thumbData = await uploadFileToBucket(IMAGE_BUCKET, thumbPath, thumbFile, thumbFile.mimetype || 'image/jpeg');
      thumbnailUrl = getPublicUrl(IMAGE_BUCKET, thumbData.path)
        || `${process.env.SUPABASE_URL?.replace(/\/$/, '')}/storage/v1/object/public/${IMAGE_BUCKET}/${thumbPath}`;
    }

    const { creatorDisplayName, creatorAvatarUrl } = await getCreatorPublicFields(uid);

    const isLive = consentGiven === true;
    const metadata = {
      title,
      description,
      videoUrl,
      streamUrl: videoUrl, // direct playable URL for HTML5 player
      thumbnailUrl,
      durationSeconds,
      userId: uid,
      creatorDisplayName: creatorDisplayName || null,
      creatorAvatarUrl: creatorAvatarUrl || null,
      consentQuestion: CONSENT_QUESTION,
      consentGiven,
      isLive,
      totalLikes: 0,
      totalComments: 0,
      createdAt: Date.now(),
    };

    await videosRef().child(videoId).set(metadata);
    return res.status(201).json({
      success: true,
      videoId,
      videoUrl,
      thumbnailUrl,
      durationSeconds,
      isLive,
      message: isLive ? 'Video published' : 'Video saved as draft (consent not given)',
    });
  } catch (err) {
    console.error('videoPublish.uploadAndPublish error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Upload failed' });
  }
}

/**
 * Public feed: only videos where isLive === true.
 */
export async function getPublicVideos(req, res) {
  try {
    const snap = await videosRef().once('value');
    const val = snap.val();
    const list = !val ? [] : Object.entries(val).map(([id, v]) => ({ ...v, videoId: id })).filter((v) => v.isLive === true);
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const enriched = await Promise.all(list.map((v) => mergeCreatorIntoPublicVideo(v)));
    return res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('videoPublish.getPublicVideos error', err?.message || err);
    return res.status(500).json({ success: false, data: [] });
  }
}

/**
 * Get one video by id. Only return if isLive or request is from owner (optional).
 */
export async function getVideoById(req, res) {
  try {
    const { videoId } = req.params;
    const requesterUid = req.uid;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    const snap = await videosRef().child(videoId).once('value');
    const data = snap.val();
    if (!data) return res.status(404).json({ success: false, message: 'Video not found' });
    if (data.isLive !== true) {
      const isOwner = requesterUid && data.userId === requesterUid;
      if (!isOwner) {
        return res.status(404).json({ success: false, message: 'Video not available' });
      }
    }
    const merged = await mergeCreatorIntoPublicVideo({ ...data, videoId });
    return res.json({ success: true, data: merged });
  } catch (err) {
    console.error('videoPublish.getVideoById error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function deleteVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    const snap = await videosRef().child(videoId).once('value');
    const video = snap.val();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.userId !== uid) return res.status(403).json({ success: false, message: 'Forbidden' });
    await videosRef().child(videoId).remove();
    await likesRef().child(videoId).remove();
    await commentsRef().child(videoId).remove();
    return res.json({ success: true });
  } catch (err) {
    console.error('videoPublish.deleteVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function updateVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    const titleRaw = req.body?.title;
    const descriptionRaw = req.body?.description;
    const snap = await videosRef().child(videoId).once('value');
    const video = snap.val();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.userId !== uid) return res.status(403).json({ success: false, message: 'Forbidden' });
    const updates = {};
    if (titleRaw !== undefined) {
      const title = String(titleRaw).trim();
      if (!title) return res.status(400).json({ success: false, message: 'Title cannot be empty' });
      updates.title = title;
    }
    if (descriptionRaw !== undefined) {
      updates.description = String(descriptionRaw).trim();
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No updates provided' });
    }
    await videosRef().child(videoId).update(updates);
    const merged = await mergeCreatorIntoPublicVideo({
      ...video,
      ...updates,
      videoId,
    });
    return res.json({ success: true, data: merged });
  } catch (err) {
    console.error('videoPublish.updateVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function setVideoDraft(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    const snap = await videosRef().child(videoId).once('value');
    const video = snap.val();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.userId !== uid) return res.status(403).json({ success: false, message: 'Forbidden' });
    await videosRef().child(videoId).child('isLive').set(false);
    const merged = await mergeCreatorIntoPublicVideo({
      ...video,
      isLive: false,
      videoId,
    });
    return res.json({ success: true, data: merged });
  } catch (err) {
    console.error('videoPublish.setVideoDraft error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Like: only if isLive. Prevent duplicate (likes/videoId/uid = true).
 */
export async function likeVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    const videoSnap = await videosRef().child(videoId).once('value');
    const video = videoSnap.val();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.isLive !== true) return res.status(400).json({ success: false, message: 'Video is not live' });

    const likeSnap = await likesRef().child(videoId).child(uid).once('value');
    if (likeSnap.val()) return res.json({ success: true, liked: true, totalLikes: video.totalLikes || 0 });

    await likesRef().child(videoId).child(uid).set(true);
    const newTotal = (video.totalLikes || 0) + 1;
    await videosRef().child(videoId).child('totalLikes').set(newTotal);
    return res.json({ success: true, liked: true, totalLikes: newTotal });
  } catch (err) {
    console.error('videoPublish.likeVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Unlike.
 */
export async function unlikeVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    const videoSnap = await videosRef().child(videoId).once('value');
    const video = videoSnap.val();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    await likesRef().child(videoId).child(uid).remove();
    const newTotal = Math.max(0, (video.totalLikes || 0) - 1);
    await videosRef().child(videoId).child('totalLikes').set(newTotal);
    return res.json({ success: true, liked: false, totalLikes: newTotal });
  } catch (err) {
    console.error('videoPublish.unlikeVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Add comment. Only if isLive.
 */
export async function addComment(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    const text = (req.body?.text || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    if (!text) return res.status(400).json({ success: false, message: 'Comment text is required' });

    const authorName = String(req.body?.authorName || '').trim().slice(0, 64) || 'Member';

    const videoSnap = await videosRef().child(videoId).once('value');
    const video = videoSnap.val();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.isLive !== true) return res.status(400).json({ success: false, message: 'Video is not live' });

    const commentId = crypto.randomUUID();
    const comment = {
      userId: uid,
      authorName,
      text,
      createdAt: Date.now(),
    };
    await commentsRef().child(videoId).child(commentId).set(comment);
    const newTotal = (video.totalComments || 0) + 1;
    await videosRef().child(videoId).child('totalComments').set(newTotal);
    return res.status(201).json({ success: true, comment: { ...comment, commentId } });
  } catch (err) {
    console.error('videoPublish.addComment error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Get comments for a video (public, only if video isLive).
 */
export async function getComments(req, res) {
  try {
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    const videoSnap = await videosRef().child(videoId).once('value');
    const video = videoSnap.val();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.isLive !== true) return res.status(404).json({ success: false, message: 'Video not available' });

    const snap = await commentsRef().child(videoId).once('value');
    const val = snap.val();
    const list = !val ? [] : Object.entries(val).map(([id, c]) => ({ ...c, commentId: id })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return res.json({ success: true, data: list });
  } catch (err) {
    console.error('videoPublish.getComments error', err?.message || err);
    return res.status(500).json({ success: false, data: [] });
  }
}

/**
 * Check if current user liked a video (for UI state).
 */
export async function getLikeStatus(req, res) {
  try {
    const uid = req.uid;
    const { videoId } = req.params;
    if (!uid) return res.json({ success: true, liked: false });
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    const snap = await likesRef().child(videoId).child(uid).once('value');
    return res.json({ success: true, liked: !!snap.val() });
  } catch (err) {
    return res.json({ success: true, liked: false });
  }
}
