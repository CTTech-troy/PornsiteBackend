/**
 * Secure video upload & publish: Supabase Storage + Firebase RTDB.
 * Consent required; only consentGiven === true sets isLive. Public feed returns only isLive === true.
 */
import { getFirebaseRtdb, getFirebaseDb } from '../config/firebase.js';
import { getCreatorPublicFields, mergeCreatorIntoPublicVideo } from '../utils/creatorProfile.js';
import { supabase, uploadFileToBucket, getPublicUrl, VIDEO_BUCKET, IMAGE_BUCKET, isConfigured as isSupabaseConfigured } from '../config/supabase.js';
import crypto from 'crypto';
import fs from 'fs';
import { ensureVideoFilenameForStorage, resolveVideoContentType } from '../utils/videoStorage.js';
import {
  MAX_UPLOAD_TITLE_LENGTH,
  MAX_UPLOAD_DESCRIPTION_LENGTH,
  normalizeTitle,
  normalizeDescription,
  getDescriptionFallback,
  normalizeTags,
  normalizeMainOrientationCategory,
  normalizeAllowPeopleToComment,
} from '../constants/uploadMetadata.js';
import {
  calculateCreatorLevel,
  getPremiumUploadLimit,
  getCurrentMonth,
  LEVEL_CONFIG,
} from '../utils/creatorLevel.js';

const CONSENT_QUESTION = 'Do you confirm you have permission to post this video?';

// ── Creator-level helpers ─────────────────────────────────────────────────────

/** Fetch followers + sum video likes for a creator, then apply the upload gate. */
async function checkPremiumUploadGate(uid) {
  try {
    const rtdb = getFirebaseRtdb();
    if (!rtdb) return { allowed: true }; // can't check → don't block

    const [userSnap, videosSnap] = await Promise.all([
      rtdb.ref(`users/${uid}`).once('value'),
      rtdb.ref('videos').orderByChild('userId').equalTo(uid).once('value'),
    ]);

    const userData = userSnap.val() || {};
    const followers = Number(userData.followers || userData.followersCount || 0);

    let totalLikes = 0;
    const vData = videosSnap.val() || {};
    Object.values(vData).forEach((v) => {
      if (v && v.isLive) totalLikes += Number(v.totalLikes || 0);
    });

    const level = calculateCreatorLevel(followers, totalLikes);
    const limit = getPremiumUploadLimit(level);
    const currentMonth = getCurrentMonth();
    const storedMonth = userData.premiumUploadMonth || '';
    const used = storedMonth === currentMonth ? Number(userData.monthlyPremiumUploads || 0) : 0;

    if (limit !== -1 && used >= limit) {
      return {
        allowed: false,
        level,
        limit,
        used,
        message: `You have reached your premium upload limit for this month (${limit} videos). Grow your audience to unlock more premium upload slots.`,
      };
    }
    return { allowed: true, level, limit, used };
  } catch {
    return { allowed: true }; // on error, don't block
  }
}

/** Increment the creator's monthly premium upload counter after a successful publish. */
async function incrementPremiumUploads(uid) {
  try {
    const rtdb = getFirebaseRtdb();
    if (!rtdb) return;
    const currentMonth = getCurrentMonth();
    const snap = await rtdb.ref(`users/${uid}`).once('value');
    const u = snap.val() || {};
    const storedMonth = u.premiumUploadMonth || '';
    const currentCount = storedMonth === currentMonth ? Number(u.monthlyPremiumUploads || 0) : 0;
    await rtdb.ref(`users/${uid}`).update({
      monthlyPremiumUploads: currentCount + 1,
      premiumUploadMonth: currentMonth,
    });
  } catch (_) {} // non-critical
}

function parseSupabasePublicStoragePath(url) {
  if (!url || typeof url !== 'string' || !url.includes('/storage/v1/object/public/')) return null;
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (!m) return null;
    const path = decodeURIComponent(m[2].replace(/\+/g, ' '));
    return { bucket: m[1], path };
  } catch {
    return null;
  }
}

async function removeSupabaseObjectsForUrls(urls) {
  if (!isSupabaseConfigured() || !supabase || !Array.isArray(urls)) return;
  const seen = new Set();
  for (const url of urls) {
    const parsed = parseSupabasePublicStoragePath(url);
    if (!parsed) continue;
    const key = `${parsed.bucket}:${parsed.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const { error } = await supabase.storage.from(parsed.bucket).remove([parsed.path]);
      if (error && !/not\s*found|No such file/i.test(String(error.message || ''))) {
        console.warn('Storage remove:', parsed.bucket, parsed.path, error.message || error);
      }
    } catch (err) {
      console.warn('Storage remove failed:', err?.message || err);
    }
  }
}

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

function parseBodyBoolean(value, fallback = true) {
  return normalizeAllowPeopleToComment(value, fallback);
}

/**
 * Step 1 of direct-upload flow: generate signed upload URLs so the browser can
 * PUT the video (and optional thumbnail) straight to Supabase Storage, bypassing
 * the backend entirely.  Returns { videoUploadUrl, videoPath, thumbnailUploadUrl?, thumbnailPath? }.
 */
export async function prepareUpload(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!isSupabaseConfigured()) return res.status(503).json({ success: false, message: 'Storage not configured' });

    const videoFilename    = String(req.body?.videoFilename    || 'video').trim() || 'video';
    const videoContentType = String(req.body?.videoContentType || 'video/mp4').trim();
    const hasThumbnail     = req.body?.hasThumbnail === true || req.body?.hasThumbnail === 'true';

    const timestamp   = Date.now();
    const safeName    = ensureVideoFilenameForStorage(videoFilename, videoContentType);
    const videoPath   = `${uid}/${timestamp}-${safeName}`;
    const thumbPath   = hasThumbnail ? `${uid}/${timestamp}-thumb.jpg` : null;

    const { data: videoData, error: videoErr } = await supabase.storage
      .from(VIDEO_BUCKET)
      .createSignedUploadUrl(videoPath);
    if (videoErr) {
      console.error('[prepareUpload] signed URL error:', videoErr.message);
      return res.status(500).json({ success: false, message: videoErr.message || 'Failed to create upload URL' });
    }

    let thumbnailUploadUrl = null;
    if (thumbPath) {
      const { data: thumbData } = await supabase.storage
        .from(IMAGE_BUCKET)
        .createSignedUploadUrl(thumbPath);
      if (thumbData) thumbnailUploadUrl = thumbData.signedUrl;
    }

    return res.json({
      success: true,
      videoUploadUrl: videoData.signedUrl,
      videoPath,
      thumbnailUploadUrl,
      thumbnailPath: thumbPath,
    });
  } catch (err) {
    console.error('[prepareUpload] error:', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to prepare upload' });
  }
}

/**
 * Step 2 of direct-upload flow: browser has already PUT the file to Supabase.
 * Receives metadata + storage paths, builds public URLs, saves to RTDB.
 */
export async function publishFromStoragePath(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!isSupabaseConfigured()) return res.status(503).json({ success: false, message: 'Storage not configured' });

    const {
      videoPath, thumbnailPath,
      title: rawTitle, description: rawDesc,
      mainOrientationCategory: rawCat, tags: rawTags,
      allowPeopleToComment: rawAllow, isPremiumContent: rawPremium,
      consentGiven: rawConsent, durationSeconds: rawDur,
      tokenPrice: rawTokenPrice,
    } = req.body || {};

    if (!videoPath) return res.status(400).json({ success: false, message: 'videoPath is required' });

    const title                = normalizeTitle(rawTitle || '');
    const description          = normalizeDescription(rawDesc || '');
    const mainOrientationCategory = normalizeMainOrientationCategory(rawCat);
    const tags                 = normalizeTags(typeof rawTags === 'string'
      ? (() => { try { return JSON.parse(rawTags); } catch { return rawTags; } })()
      : rawTags);
    const allowPeopleToComment = parseBodyBoolean(rawAllow, true);
    const isPremiumContent     = rawPremium === true || rawPremium === 'true';
    const consentGiven         = rawConsent === true || rawConsent === 'true';
    const tokenPrice           = isPremiumContent ? Math.max(0, parseInt(String(rawTokenPrice || '0'), 10) || 0) : 0;

    if (!mainOrientationCategory)
      return res.status(400).json({ success: false, message: 'Main category is required' });
    if (!Array.isArray(tags) || tags.length < 1)
      return res.status(400).json({ success: false, message: 'At least one tag is required' });

    // Premium upload gate — check level and monthly quota
    if (isPremiumContent) {
      const gate = await checkPremiumUploadGate(uid);
      if (!gate.allowed) {
        return res.status(403).json({
          success: false,
          error: 'PREMIUM_UPLOAD_LIMIT_REACHED',
          message: gate.message,
          level: gate.level,
          limit: gate.limit,
          used: gate.used,
        });
      }
    }

    let durationSeconds = 0;
    if (rawDur != null) {
      const n = parseInt(String(rawDur), 10);
      if (!Number.isNaN(n) && n >= 0) durationSeconds = Math.min(n, 86400 * 48);
    }

    const baseUrl      = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const videoUrl     = getPublicUrl(VIDEO_BUCKET, videoPath)
      || (baseUrl ? `${baseUrl}/storage/v1/object/public/${VIDEO_BUCKET}/${videoPath.split('/').map(encodeURIComponent).join('/')}` : null);
    const thumbnailUrl = thumbnailPath
      ? (getPublicUrl(IMAGE_BUCKET, thumbnailPath)
          || (baseUrl ? `${baseUrl}/storage/v1/object/public/${IMAGE_BUCKET}/${thumbnailPath}` : null))
      : null;

    if (!videoUrl) return res.status(500).json({ success: false, message: 'Could not resolve video URL' });
    if (!videosRef()) return res.status(503).json({ success: false, message: 'Video metadata storage is temporarily unavailable.' });

    const { creatorDisplayName, creatorAvatarUrl } = await getCreatorPublicFields(uid);
    const videoId = crypto.randomUUID();
    const isLive  = consentGiven;

    await videosRef().child(videoId).set({
      title,
      description: description || getDescriptionFallback(title),
      mainOrientationCategory,
      category: mainOrientationCategory,
      tags,
      allowPeopleToComment,
      videoUrl,
      streamUrl: videoUrl,
      thumbnailUrl,
      durationSeconds,
      userId: uid,
      creatorDisplayName: creatorDisplayName || null,
      creatorAvatarUrl:   creatorAvatarUrl   || null,
      consentQuestion: CONSENT_QUESTION,
      consentGiven,
      isLive,
      isPremiumContent,
      tokenPrice,
      totalLikes:    0,
      totalComments: 0,
      createdAt: Date.now(),
    });

    // Track monthly premium upload count (fire-and-forget)
    if (isPremiumContent) incrementPremiumUploads(uid);

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
    console.error('[publishFromStoragePath] error:', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Publish failed' });
  }
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
    const title = normalizeTitle(req.body?.title || '');
    const description = normalizeDescription(req.body?.description || '');
    const consentGiven = req.body?.consentGiven === true || req.body?.consentGiven === 'true';
    const mainOrientationCategory = normalizeMainOrientationCategory(req.body?.mainOrientationCategory || req.body?.category);
    const tags = normalizeTags(req.body?.tags ? (() => {
      try {
        return JSON.parse(req.body.tags);
      } catch {
        return req.body.tags;
      }
    })() : []);
    const allowPeopleToComment = parseBodyBoolean(req.body?.allowPeopleToComment, true);
    const isPremiumContent = req.body?.isPremiumContent === 'true' || req.body?.isPremiumContent === true;
    const tokenPrice = isPremiumContent ? Math.max(0, parseInt(String(req.body?.tokenPrice || '0'), 10) || 0) : 0;

    if (!mainOrientationCategory) {
      return res.status(400).json({ success: false, message: 'Main category is required' });
    }
    if (!Array.isArray(tags) || tags.length < 1) {
      return res.status(400).json({ success: false, message: 'At least one tag is required' });
    }
    if (title.length > MAX_UPLOAD_TITLE_LENGTH) {
      return res.status(400).json({ success: false, message: `Title must be at most ${MAX_UPLOAD_TITLE_LENGTH} characters` });
    }
    if (description.length > MAX_UPLOAD_DESCRIPTION_LENGTH) {
      return res.status(400).json({ success: false, message: `Description must be at most ${MAX_UPLOAD_DESCRIPTION_LENGTH} characters` });
    }
    if (!file) return res.status(400).json({ success: false, message: 'Video file is required' });
    if (req.body?.consentGiven === undefined && req.body?.consentGiven !== false)
      return res.status(400).json({ success: false, message: 'You must answer the consent question' });

    // Premium upload gate — check level and monthly quota before uploading file
    if (isPremiumContent) {
      const gate = await checkPremiumUploadGate(uid);
      if (!gate.allowed) {
        return res.status(403).json({
          success: false,
          error: 'PREMIUM_UPLOAD_LIMIT_REACHED',
          message: gate.message,
          level: gate.level,
          limit: gate.limit,
          used: gate.used,
        });
      }
    }

    const rawDur = req.body?.durationSeconds ?? req.body?.duration;
    let durationSeconds = 0;
    if (rawDur != null && String(rawDur).trim() !== '') {
      const n = parseInt(String(rawDur), 10);
      if (!Number.isNaN(n) && n >= 0) durationSeconds = Math.min(n, 86400 * 48);
    }

    const videoId = crypto.randomUUID();
    const timestamp = Date.now();
    const safeName = ensureVideoFilenameForStorage(file.originalname, file.mimetype);
    const storagePath = `${uid}/${timestamp}-${safeName}`;
    const contentType = resolveVideoContentType(file.mimetype, safeName);

    let videoUrl = null;
    if (isSupabaseConfigured()) {
      const data = await uploadFileToBucket(VIDEO_BUCKET, storagePath, file, contentType);
      const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
      videoUrl =
        getPublicUrl(VIDEO_BUCKET, data.path) ||
        (baseUrl
          ? `${baseUrl}/storage/v1/object/public/${VIDEO_BUCKET}/${data.path.split('/').map(encodeURIComponent).join('/')}`
          : null);
    } else {
      return res.status(503).json({ success: false, message: 'Storage not configured' });
    }

    let thumbnailUrl = null;
    const thumbFile = req.thumbnailFile;
    // Support both multer memory storage (file.buffer) and disk storage (file.path)
    const thumbReady = thumbFile && (
      (thumbFile.buffer && thumbFile.buffer.length > 0) ||
      (thumbFile.path && thumbFile.size > 0)
    );
    if (thumbReady && isSupabaseConfigured()) {
      const thumbPath = `${uid}/${timestamp}-thumb.jpg`;
      const thumbData = await uploadFileToBucket(IMAGE_BUCKET, thumbPath, thumbFile, thumbFile.mimetype || 'image/jpeg');
      thumbnailUrl = getPublicUrl(IMAGE_BUCKET, thumbData.path)
        || `${process.env.SUPABASE_URL?.replace(/\/$/, '')}/storage/v1/object/public/${IMAGE_BUCKET}/${thumbPath}`;
    }

    const { creatorDisplayName, creatorAvatarUrl } = await getCreatorPublicFields(uid);

    const isLive = consentGiven === true;
    const metadata = {
      title,
      description: description || getDescriptionFallback(title),
      mainOrientationCategory,
      category: mainOrientationCategory,
      tags,
      allowPeopleToComment,
      videoUrl,
      streamUrl: videoUrl,
      thumbnailUrl,
      durationSeconds,
      userId: uid,
      creatorDisplayName: creatorDisplayName || null,
      creatorAvatarUrl: creatorAvatarUrl || null,
      consentQuestion: CONSENT_QUESTION,
      consentGiven,
      isLive,
      isPremiumContent,
      tokenPrice,
      totalLikes: 0,
      totalComments: 0,
      createdAt: Date.now(),
    };

    if (!videosRef()) {
      return res.status(503).json({ success: false, message: 'Video metadata storage is temporarily unavailable.' });
    }

    await videosRef().child(videoId).set(metadata);

    // Track monthly premium upload count (fire-and-forget)
    if (isPremiumContent) incrementPremiumUploads(uid);

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
  } finally {
    // Clean up disk-storage temp files (no-op if memoryStorage was used)
    if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
    if (req.thumbnailFile?.path) fs.promises.unlink(req.thumbnailFile.path).catch(() => {});
  }
}

/**
 * Public feed: only videos where isLive === true.
 */
export async function getPublicVideos(req, res) {
  try {
    if (!videosRef()) {
      return res.json({ success: true, data: [] });
    }
    const premiumOnly = req.query?.premium === 'true';
    const snap = await videosRef().once('value');
    const val = snap.val();
    let list = !val ? [] : Object.entries(val).map(([id, v]) => ({ ...v, videoId: id })).filter((v) => v.isLive === true);
    if (premiumOnly) {
      list = list.filter((v) => v.isPremiumContent === true);
    }
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
    if (!videosRef()) {
      return res.status(503).json({ success: false, message: 'Video feed is temporarily unavailable.' });
    }
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
    if (!videosRef()) {
      return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    }
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    const snap = await videosRef().child(videoId).once('value');
    const video = snap.val();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.userId !== uid) return res.status(403).json({ success: false, message: 'Forbidden' });
    const storageUrls = [video.videoUrl, video.streamUrl, video.thumbnailUrl].filter(
      (u) => typeof u === 'string' && u.includes('/storage/v1/object/public/')
    );
    await removeSupabaseObjectsForUrls(storageUrls);
    await videosRef().child(videoId).remove();
    const lr = likesRef();
    const cr = commentsRef();
    if (lr) await lr.child(videoId).remove();
    if (cr) await cr.child(videoId).remove();
    return res.json({ success: true });
  } catch (err) {
    console.error('videoPublish.deleteVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function updateVideo(req, res) {
  try {
    if (!videosRef()) {
      return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    }
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    const titleRaw = req.body?.title;
    const descriptionRaw = req.body?.description;
    const categoryRaw = req.body?.category;
    const mainOrientationCategoryRaw = req.body?.mainOrientationCategory;
    const tagsRaw = req.body?.tags;
    const allowPeopleToCommentRaw = req.body?.allowPeopleToComment;
    const snap = await videosRef().child(videoId).once('value');
    const video = snap.val();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.userId !== uid) return res.status(403).json({ success: false, message: 'Forbidden' });
    const updates = {};
    if (titleRaw !== undefined) {
      const title = String(titleRaw).trim();
      if (title.length > MAX_UPLOAD_TITLE_LENGTH) {
        return res.status(400).json({ success: false, message: `Title must be at most ${MAX_UPLOAD_TITLE_LENGTH} characters` });
      }
      updates.title = title;
    }
    if (descriptionRaw !== undefined) {
      const normalized = normalizeDescription(descriptionRaw);
      if (normalized.length > MAX_UPLOAD_DESCRIPTION_LENGTH) {
        return res.status(400).json({ success: false, message: `Description must be at most ${MAX_UPLOAD_DESCRIPTION_LENGTH} characters` });
      }
      const titleForFallback = titleRaw !== undefined ? normalizeTitle(titleRaw) : normalizeTitle(video?.title || '');
      updates.description = normalized || getDescriptionFallback(titleForFallback);
    }
    if (mainOrientationCategoryRaw !== undefined) {
      const normalized = normalizeMainOrientationCategory(mainOrientationCategoryRaw);
      if (!normalized) {
        return res.status(400).json({ success: false, message: 'Invalid main category' });
      }
      updates.mainOrientationCategory = normalized;
      updates.category = normalized;
    }
    if (categoryRaw !== undefined) {
      const normalized = normalizeMainOrientationCategory(categoryRaw);
      if (!normalized) {
        return res.status(400).json({ success: false, message: 'Invalid main category' });
      }
      updates.mainOrientationCategory = normalized;
      updates.category = normalized;
    }
    if (tagsRaw !== undefined) {
      const tagsInput = (() => {
        if (typeof tagsRaw !== 'string') return tagsRaw;
        try {
          return JSON.parse(tagsRaw);
        } catch {
          return tagsRaw;
        }
      })();
      const tags = normalizeTags(tagsInput);
      if (!Array.isArray(tags) || tags.length < 1) {
        return res.status(400).json({ success: false, message: 'At least one tag is required' });
      }
      updates.tags = tags;
    }
    if (allowPeopleToCommentRaw !== undefined) {
      updates.allowPeopleToComment = parseBodyBoolean(allowPeopleToCommentRaw, true);
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
    if (!videosRef()) {
      return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    }
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
    if (!videosRef() || !likesRef()) {
      return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    }
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
    if (!videosRef() || !likesRef()) {
      return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    }
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
    if (!videosRef() || !commentsRef()) {
      return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    }
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
    if (video.allowPeopleToComment === false) {
      return res.status(403).json({ success: false, message: 'Comments are disabled for this video' });
    }

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
    if (!videosRef() || !commentsRef()) {
      return res.json({ success: true, data: [] });
    }
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
 * Purchase a premium video using tokens. Atomically deducts tokens from Firestore
 * and records the purchase in RTDB.
 */
export async function purchaseVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    const rtdb = getFirebaseRtdb();
    if (!rtdb || !videosRef()) return res.status(503).json({ success: false, message: 'Storage unavailable' });

    const videoSnap = await videosRef().child(videoId).once('value');
    const video = videoSnap.val();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (!video.isLive) return res.status(400).json({ success: false, message: 'Video not available' });
    if (!video.isPremiumContent) return res.status(400).json({ success: false, message: 'Video is not premium content' });

    const tokenPrice = Number(video.tokenPrice) || 0;

    // Already purchased?
    const purchaseSnap = await rtdb.ref(`purchases/${uid}/${videoId}`).once('value');
    if (purchaseSnap.val()) {
      return res.json({ success: true, alreadyPurchased: true, message: 'Already purchased' });
    }

    let newTokenBalance;
    if (tokenPrice > 0) {
      const firestoreDb = getFirebaseDb();
      if (!firestoreDb) {
        return res.status(503).json({ success: false, message: 'Database unavailable for token deduction' });
      }
      const userRef = firestoreDb.collection('users').doc(uid);
      try {
        newTokenBalance = await firestoreDb.runTransaction(async (t) => {
          const userDoc = await t.get(userRef);
          const userData = userDoc.exists ? userDoc.data() : {};
          const balance = Number(userData.tokenBalance ?? userData.coinBalance ?? 0);
          if (balance < tokenPrice) throw new Error('INSUFFICIENT_TOKENS');
          const updated = balance - tokenPrice;
          t.update(userRef, { tokenBalance: updated });
          return updated;
        });
      } catch (err) {
        if (err.message === 'INSUFFICIENT_TOKENS') {
          return res.status(402).json({ success: false, message: 'Insufficient tokens. Please purchase more tokens.' });
        }
        throw err;
      }
    }

    await rtdb.ref(`purchases/${uid}/${videoId}`).set({
      purchasedAt: Date.now(),
      tokenPrice,
      videoId,
      userId: uid,
    });

    return res.json({
      success: true,
      message: 'Purchase successful',
      ...(newTokenBalance !== undefined ? { newTokenBalance } : {}),
    });
  } catch (err) {
    console.error('videoPublish.purchaseVideo error:', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Purchase failed' });
  }
}

/**
 * Check if the authenticated user has purchased a specific premium video.
 */
export async function getVideoPurchaseStatus(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.json({ success: true, purchased: false });

    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    const rtdb = getFirebaseRtdb();
    if (!rtdb) return res.json({ success: true, purchased: false });

    const snap = await rtdb.ref(`purchases/${uid}/${videoId}`).once('value');
    const data = snap.val();
    return res.json({ success: true, purchased: !!data, purchasedAt: data?.purchasedAt || null });
  } catch (err) {
    console.error('videoPublish.getVideoPurchaseStatus error:', err?.message || err);
    return res.json({ success: true, purchased: false });
  }
}

/**
 * Check if current user liked a video (for UI state).
 */
export async function getLikeStatus(req, res) {
  try {
    if (!likesRef()) {
      return res.json({ success: true, liked: false });
    }
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

/**
 * GET /api/videos/creator-level — return authenticated creator's level, quota, and progress.
 */
export async function getCreatorLevel(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });

    const rtdb = getFirebaseRtdb();
    if (!rtdb) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const [userSnap, videosSnap] = await Promise.all([
      rtdb.ref(`users/${uid}`).once('value'),
      rtdb.ref('videos').orderByChild('userId').equalTo(uid).once('value'),
    ]);

    const userData = userSnap.val() || {};
    const followers = Number(userData.followers || userData.followersCount || 0);

    let totalLikes = 0;
    const vData = videosSnap.val() || {};
    Object.values(vData).forEach((v) => {
      if (v && v.isLive) totalLikes += Number(v.totalLikes || 0);
    });

    const level = calculateCreatorLevel(followers, totalLikes);
    const limit = getPremiumUploadLimit(level);
    const currentMonth = getCurrentMonth();
    const storedMonth = userData.premiumUploadMonth || '';
    const uploadsUsed = storedMonth === currentMonth ? Number(userData.monthlyPremiumUploads || 0) : 0;

    const nextLevel = level < 3 ? level + 1 : null;
    const nextConfig = nextLevel ? LEVEL_CONFIG[nextLevel] : null;

    return res.json({
      success: true,
      level,
      levelName: LEVEL_CONFIG[level].name,
      premiumUploadLimit: limit,
      premiumUploadsUsed: uploadsUsed,
      premiumUploadsRemaining: limit === -1 ? null : Math.max(0, limit - uploadsUsed),
      unlimited: limit === -1,
      followersCount: followers,
      totalLikes,
      nextLevel,
      nextLevelName: nextConfig?.name || null,
      nextLevelFollowers: nextLevel === 2 ? 1000 : nextLevel === 3 ? 10000 : null,
      nextLevelLikes: nextLevel === 2 ? 1000 : null,
    });
  } catch (err) {
    console.error('videoPublish.getCreatorLevel error:', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}
