/**
 * Secure video upload & publish — Supabase primary.
 * All video metadata, likes, comments, and purchases stored in Supabase.
 * Firebase RTDB dependency removed.
 */
import { supabase, uploadFileToBucket, getPublicUrl, VIDEO_BUCKET, IMAGE_BUCKET, isConfigured as isSupabaseConfigured } from '../config/supabase.js';
import { getCreatorPublicFields, mergeCreatorIntoPublicVideo } from '../utils/creatorProfile.js';
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

// ── Supabase row → API response shape ─────────────────────────────────────────

function mapVideo(row) {
  return {
    videoId:                row.video_id,
    userId:                 row.user_id,
    title:                  row.title                  || '',
    description:            row.description            || '',
    mainOrientationCategory: row.main_orientation_category || '',
    category:               row.main_orientation_category || '',
    tags:                   row.tags                   || [],
    allowPeopleToComment:   row.allow_people_to_comment !== false,
    videoUrl:               row.storage_url            || row.stream_url || '',
    streamUrl:              row.stream_url             || row.storage_url || '',
    thumbnailUrl:           row.thumbnail_url          || null,
    durationSeconds:        Number(row.duration        || 0),
    creatorDisplayName:     row.creator_display_name   || null,
    creatorAvatarUrl:       row.creator_avatar_url     || null,
    consentQuestion:        CONSENT_QUESTION,
    consentGiven:           row.consent_given          || false,
    isLive:                 row.is_live                || false,
    isPremiumContent:       row.is_premium_content     || false,
    tokenPrice:             Number(row.token_price     || row.coin_price || 0),
    totalLikes:             Number(row.likes_count     || 0),
    totalComments:          Number(row.comments_count  || 0),
    totalViews:             Number(row.views_count     || 0),
    createdAt:              row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

// ── Premium upload gate ────────────────────────────────────────────────────────

async function checkPremiumUploadGate(uid) {
  try {
    if (!supabase) return { allowed: true };

    const [{ data: user }, { data: videos }] = await Promise.all([
      supabase.from('users').select('followers, monthly_premium_uploads, premium_upload_month').eq('id', uid).maybeSingle(),
      supabase.from('tiktok_videos').select('likes_count').eq('user_id', uid).eq('is_live', true),
    ]);

    const followers  = Number(user?.followers || 0);
    const totalLikes = (videos || []).reduce((s, v) => s + Number(v.likes_count || 0), 0);
    const level      = calculateCreatorLevel(followers, totalLikes);
    const limit      = getPremiumUploadLimit(level);
    const currentMonth = getCurrentMonth();
    const storedMonth  = user?.premium_upload_month || '';
    const used = storedMonth === currentMonth ? Number(user?.monthly_premium_uploads || 0) : 0;

    if (limit !== -1 && used >= limit) {
      return {
        allowed: false, level, limit, used,
        message: `You have reached your premium upload limit for this month (${limit} videos). Grow your audience to unlock more premium upload slots.`,
      };
    }
    return { allowed: true, level, limit, used };
  } catch {
    return { allowed: true };
  }
}

async function incrementPremiumUploads(uid) {
  try {
    if (!supabase) return;
    const currentMonth = getCurrentMonth();
    const { data: user } = await supabase
      .from('users')
      .select('monthly_premium_uploads, premium_upload_month')
      .eq('id', uid)
      .maybeSingle();
    const storedMonth  = user?.premium_upload_month || '';
    const currentCount = storedMonth === currentMonth ? Number(user?.monthly_premium_uploads || 0) : 0;
    await supabase.from('users').update({
      monthly_premium_uploads: currentCount + 1,
      premium_upload_month:    currentMonth,
    }).eq('id', uid);
  } catch (_) {}
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function parseSupabasePublicStoragePath(url) {
  if (!url || typeof url !== 'string' || !url.includes('/storage/v1/object/public/')) return null;
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (!m) return null;
    return { bucket: m[1], path: decodeURIComponent(m[2].replace(/\+/g, ' ')) };
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

function parseBodyBoolean(value, fallback = true) {
  return normalizeAllowPeopleToComment(value, fallback);
}

// ── Signed upload URL (direct browser → Supabase) ────────────────────────────

export async function prepareUpload(req, res) {
  try {
    const uid = req.uid;
    if (!uid)                   return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!isSupabaseConfigured()) return res.status(503).json({ success: false, message: 'Storage not configured' });

    const videoFilename    = String(req.body?.videoFilename    || 'video').trim() || 'video';
    const videoContentType = String(req.body?.videoContentType || 'video/mp4').trim();
    const hasThumbnail     = req.body?.hasThumbnail === true || req.body?.hasThumbnail === 'true';

    const timestamp  = Date.now();
    const safeName   = ensureVideoFilenameForStorage(videoFilename, videoContentType);
    const videoPath  = `${uid}/${timestamp}-${safeName}`;
    const thumbPath  = hasThumbnail ? `${uid}/${timestamp}-thumb.jpg` : null;

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

// ── Publish from already-uploaded storage path ────────────────────────────────

export async function publishFromStoragePath(req, res) {
  try {
    const uid = req.uid;
    if (!uid)                    return res.status(401).json({ success: false, message: 'Authentication required' });
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

    const title                  = normalizeTitle(rawTitle || '');
    const description            = normalizeDescription(rawDesc || '');
    const mainOrientationCategory = normalizeMainOrientationCategory(rawCat);
    const tags                   = normalizeTags(typeof rawTags === 'string'
      ? (() => { try { return JSON.parse(rawTags); } catch { return rawTags; } })()
      : rawTags);
    const allowPeopleToComment   = parseBodyBoolean(rawAllow, true);
    const isPremiumContent       = rawPremium === true || rawPremium === 'true';
    const consentGiven           = rawConsent === true || rawConsent === 'true';
    const tokenPrice             = isPremiumContent ? Math.max(0, parseInt(String(rawTokenPrice || '0'), 10) || 0) : 0;

    if (!mainOrientationCategory)
      return res.status(400).json({ success: false, message: 'Main category is required' });
    if (!Array.isArray(tags) || tags.length < 1)
      return res.status(400).json({ success: false, message: 'At least one tag is required' });

    if (isPremiumContent) {
      const gate = await checkPremiumUploadGate(uid);
      if (!gate.allowed) {
        return res.status(403).json({
          success: false, error: 'PREMIUM_UPLOAD_LIMIT_REACHED',
          message: gate.message, level: gate.level, limit: gate.limit, used: gate.used,
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
      ? (getPublicUrl(IMAGE_BUCKET, thumbnailPath) || (baseUrl ? `${baseUrl}/storage/v1/object/public/${IMAGE_BUCKET}/${thumbnailPath}` : null))
      : null;

    if (!videoUrl) return res.status(500).json({ success: false, message: 'Could not resolve video URL' });

    const { creatorDisplayName, creatorAvatarUrl } = await getCreatorPublicFields(uid);
    const videoId = crypto.randomUUID();
    const isLive  = consentGiven;

    const { error: insertErr } = await supabase.from('tiktok_videos').insert([{
      video_id:                 videoId,
      user_id:                  uid,
      storage_url:              videoUrl,
      stream_url:               videoUrl,
      title,
      description:              description || getDescriptionFallback(title),
      main_orientation_category: mainOrientationCategory,
      tags,
      allow_people_to_comment:  allowPeopleToComment,
      thumbnail_url:            thumbnailUrl,
      duration:                 durationSeconds,
      is_live:                  isLive,
      is_premium_content:       isPremiumContent,
      token_price:              tokenPrice,
      consent_given:            consentGiven,
      creator_display_name:     creatorDisplayName || null,
      creator_avatar_url:       creatorAvatarUrl   || null,
      status:                   isLive ? 'published' : 'draft',
    }]);
    if (insertErr) throw insertErr;

    if (isPremiumContent) incrementPremiumUploads(uid);

    return res.status(201).json({
      success: true, videoId, videoUrl, thumbnailUrl, durationSeconds, isLive,
      message: isLive ? 'Video published' : 'Video saved as draft (consent not given)',
    });
  } catch (err) {
    console.error('[publishFromStoragePath] error:', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Publish failed' });
  }
}

// ── Upload file + publish ─────────────────────────────────────────────────────

export async function uploadAndPublish(req, res) {
  try {
    const uid  = req.uid;
    if (!uid)  return res.status(401).json({ success: false, message: 'Authentication required' });

    const file        = req.file;
    const title       = normalizeTitle(req.body?.title || '');
    const description = normalizeDescription(req.body?.description || '');
    const consentGiven = req.body?.consentGiven === true || req.body?.consentGiven === 'true';
    const mainOrientationCategory = normalizeMainOrientationCategory(req.body?.mainOrientationCategory || req.body?.category);
    const tags = normalizeTags(req.body?.tags ? (() => {
      try { return JSON.parse(req.body.tags); } catch { return req.body.tags; }
    })() : []);
    const allowPeopleToComment = parseBodyBoolean(req.body?.allowPeopleToComment, true);
    const isPremiumContent     = req.body?.isPremiumContent === 'true' || req.body?.isPremiumContent === true;
    const tokenPrice           = isPremiumContent ? Math.max(0, parseInt(String(req.body?.tokenPrice || '0'), 10) || 0) : 0;

    if (!mainOrientationCategory) return res.status(400).json({ success: false, message: 'Main category is required' });
    if (!Array.isArray(tags) || tags.length < 1) return res.status(400).json({ success: false, message: 'At least one tag is required' });
    if (title.length > MAX_UPLOAD_TITLE_LENGTH) return res.status(400).json({ success: false, message: `Title must be at most ${MAX_UPLOAD_TITLE_LENGTH} characters` });
    if (description.length > MAX_UPLOAD_DESCRIPTION_LENGTH) return res.status(400).json({ success: false, message: `Description must be at most ${MAX_UPLOAD_DESCRIPTION_LENGTH} characters` });
    if (!file) return res.status(400).json({ success: false, message: 'Video file is required' });
    if (req.body?.consentGiven === undefined && req.body?.consentGiven !== false)
      return res.status(400).json({ success: false, message: 'You must answer the consent question' });

    if (isPremiumContent) {
      const gate = await checkPremiumUploadGate(uid);
      if (!gate.allowed) {
        return res.status(403).json({
          success: false, error: 'PREMIUM_UPLOAD_LIMIT_REACHED',
          message: gate.message, level: gate.level, limit: gate.limit, used: gate.used,
        });
      }
    }

    const rawDur = req.body?.durationSeconds ?? req.body?.duration;
    let durationSeconds = 0;
    if (rawDur != null && String(rawDur).trim() !== '') {
      const n = parseInt(String(rawDur), 10);
      if (!Number.isNaN(n) && n >= 0) durationSeconds = Math.min(n, 86400 * 48);
    }

    const videoId     = crypto.randomUUID();
    const timestamp   = Date.now();
    const safeName    = ensureVideoFilenameForStorage(file.originalname, file.mimetype);
    const storagePath = `${uid}/${timestamp}-${safeName}`;
    const contentType = resolveVideoContentType(file.mimetype, safeName);

    let videoUrl = null;
    if (isSupabaseConfigured()) {
      const data  = await uploadFileToBucket(VIDEO_BUCKET, storagePath, file, contentType);
      const base  = process.env.SUPABASE_URL?.replace(/\/$/, '');
      videoUrl    = getPublicUrl(VIDEO_BUCKET, data.path)
        || (base ? `${base}/storage/v1/object/public/${VIDEO_BUCKET}/${data.path.split('/').map(encodeURIComponent).join('/')}` : null);
    } else {
      return res.status(503).json({ success: false, message: 'Storage not configured' });
    }

    let thumbnailUrl = null;
    const thumbFile  = req.thumbnailFile;
    const thumbReady = thumbFile && ((thumbFile.buffer && thumbFile.buffer.length > 0) || (thumbFile.path && thumbFile.size > 0));
    if (thumbReady && isSupabaseConfigured()) {
      const thumbPath  = `${uid}/${timestamp}-thumb.jpg`;
      const thumbData  = await uploadFileToBucket(IMAGE_BUCKET, thumbPath, thumbFile, thumbFile.mimetype || 'image/jpeg');
      thumbnailUrl     = getPublicUrl(IMAGE_BUCKET, thumbData.path)
        || `${process.env.SUPABASE_URL?.replace(/\/$/, '')}/storage/v1/object/public/${IMAGE_BUCKET}/${thumbPath}`;
    }

    const { creatorDisplayName, creatorAvatarUrl } = await getCreatorPublicFields(uid);
    const isLive = consentGiven === true;

    const { error: insertErr } = await supabase.from('tiktok_videos').insert([{
      video_id:                 videoId,
      user_id:                  uid,
      storage_url:              videoUrl,
      stream_url:               videoUrl,
      title,
      description:              description || getDescriptionFallback(title),
      main_orientation_category: mainOrientationCategory,
      tags,
      allow_people_to_comment:  allowPeopleToComment,
      thumbnail_url:            thumbnailUrl,
      duration:                 durationSeconds,
      is_live:                  isLive,
      is_premium_content:       isPremiumContent,
      token_price:              tokenPrice,
      consent_given:            consentGiven,
      creator_display_name:     creatorDisplayName || null,
      creator_avatar_url:       creatorAvatarUrl   || null,
      status:                   isLive ? 'published' : 'draft',
    }]);
    if (insertErr) throw insertErr;

    if (isPremiumContent) incrementPremiumUploads(uid);

    return res.status(201).json({
      success: true, videoId, videoUrl, thumbnailUrl, durationSeconds, isLive,
      message: isLive ? 'Video published' : 'Video saved as draft (consent not given)',
    });
  } catch (err) {
    console.error('videoPublish.uploadAndPublish error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Upload failed' });
  } finally {
    if (req.file?.path)          fs.promises.unlink(req.file.path).catch(() => {});
    if (req.thumbnailFile?.path) fs.promises.unlink(req.thumbnailFile.path).catch(() => {});
  }
}

// ── Public feed ───────────────────────────────────────────────────────────────

export async function getPublicVideos(req, res) {
  try {
    if (!supabase) return res.json({ success: true, data: [] });

    const premiumOnly = req.query?.premium === 'true';
    let query = supabase
      .from('tiktok_videos')
      .select('*')
      .eq('is_live', true)
      .order('created_at', { ascending: false });

    if (premiumOnly) query = query.eq('is_premium_content', true);

    const { data, error } = await query;
    if (error) throw error;

    const list    = (data || []).map(mapVideo);
    const enriched = await Promise.all(list.map((v) => mergeCreatorIntoPublicVideo(v)));
    return res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('videoPublish.getPublicVideos error', err?.message || err);
    return res.status(500).json({ success: false, data: [] });
  }
}

// ── Single video ──────────────────────────────────────────────────────────────

export async function getVideoById(req, res) {
  try {
    if (!supabase) return res.status(503).json({ success: false, message: 'Video feed is temporarily unavailable.' });
    const { videoId }     = req.params;
    const requesterUid    = req.uid;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    const { data, error } = await supabase
      .from('tiktok_videos')
      .select('*')
      .eq('video_id', videoId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'Video not found' });

    if (data.is_live !== true) {
      const isOwner = requesterUid && data.user_id === requesterUid;
      if (!isOwner) return res.status(404).json({ success: false, message: 'Video not available' });
    }

    const merged = await mergeCreatorIntoPublicVideo(mapVideo(data));
    return res.json({ success: true, data: merged });
  } catch (err) {
    console.error('videoPublish.getVideoById error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteVideo(req, res) {
  try {
    if (!supabase) return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!uid)      return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!videoId)  return res.status(400).json({ success: false, message: 'videoId required' });

    const { data: video } = await supabase.from('tiktok_videos').select('*').eq('video_id', videoId).maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.user_id !== uid) return res.status(403).json({ success: false, message: 'Forbidden' });

    const storageUrls = [video.storage_url, video.stream_url, video.thumbnail_url]
      .filter((u) => typeof u === 'string' && u.includes('/storage/v1/object/public/'));
    await removeSupabaseObjectsForUrls(storageUrls);

    const { error } = await supabase.from('tiktok_videos').delete().eq('video_id', videoId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('videoPublish.deleteVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

// ── Update metadata ───────────────────────────────────────────────────────────

export async function updateVideo(req, res) {
  try {
    if (!supabase) return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!uid)      return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!videoId)  return res.status(400).json({ success: false, message: 'videoId required' });

    const { data: video } = await supabase.from('tiktok_videos').select('*').eq('video_id', videoId).maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.user_id !== uid) return res.status(403).json({ success: false, message: 'Forbidden' });

    const {
      title: titleRaw, description: descriptionRaw,
      category: categoryRaw, mainOrientationCategory: mainOrientationCategoryRaw,
      tags: tagsRaw, allowPeopleToComment: allowPeopleToCommentRaw,
    } = req.body || {};

    const updates = {};
    if (titleRaw !== undefined) {
      const t = String(titleRaw).trim();
      if (t.length > MAX_UPLOAD_TITLE_LENGTH) return res.status(400).json({ success: false, message: `Title must be at most ${MAX_UPLOAD_TITLE_LENGTH} characters` });
      updates.title = t;
    }
    if (descriptionRaw !== undefined) {
      const d = normalizeDescription(descriptionRaw);
      if (d.length > MAX_UPLOAD_DESCRIPTION_LENGTH) return res.status(400).json({ success: false, message: `Description must be at most ${MAX_UPLOAD_DESCRIPTION_LENGTH} characters` });
      updates.description = d || getDescriptionFallback(updates.title || normalizeTitle(video.title || ''));
    }
    const catRaw = mainOrientationCategoryRaw !== undefined ? mainOrientationCategoryRaw : categoryRaw;
    if (catRaw !== undefined) {
      const cat = normalizeMainOrientationCategory(catRaw);
      if (!cat) return res.status(400).json({ success: false, message: 'Invalid main category' });
      updates.main_orientation_category = cat;
    }
    if (tagsRaw !== undefined) {
      const tagsInput = (() => {
        if (typeof tagsRaw !== 'string') return tagsRaw;
        try { return JSON.parse(tagsRaw); } catch { return tagsRaw; }
      })();
      const tags = normalizeTags(tagsInput);
      if (!Array.isArray(tags) || tags.length < 1) return res.status(400).json({ success: false, message: 'At least one tag is required' });
      updates.tags = tags;
    }
    if (allowPeopleToCommentRaw !== undefined) {
      updates.allow_people_to_comment = parseBodyBoolean(allowPeopleToCommentRaw, true);
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ success: false, message: 'No updates provided' });

    const { data: updated, error } = await supabase
      .from('tiktok_videos').update(updates).eq('video_id', videoId).select().single();
    if (error) throw error;

    const merged = await mergeCreatorIntoPublicVideo(mapVideo(updated));
    return res.json({ success: true, data: merged });
  } catch (err) {
    console.error('videoPublish.updateVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

// ── Draft / publish toggle ────────────────────────────────────────────────────

export async function setVideoDraft(req, res) {
  try {
    if (!supabase) return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!uid)      return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!videoId)  return res.status(400).json({ success: false, message: 'videoId required' });

    const { data: video } = await supabase.from('tiktok_videos').select('user_id').eq('video_id', videoId).maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.user_id !== uid) return res.status(403).json({ success: false, message: 'Forbidden' });

    const { data: updated, error } = await supabase
      .from('tiktok_videos').update({ is_live: false, status: 'draft' }).eq('video_id', videoId).select().single();
    if (error) throw error;

    const merged = await mergeCreatorIntoPublicVideo(mapVideo(updated));
    return res.json({ success: true, data: merged });
  } catch (err) {
    console.error('videoPublish.setVideoDraft error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

// ── Like / unlike ─────────────────────────────────────────────────────────────

export async function likeVideo(req, res) {
  try {
    if (!supabase) return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!uid)      return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!videoId)  return res.status(400).json({ success: false, message: 'videoId required' });

    const { data: video } = await supabase.from('tiktok_videos').select('is_live, likes_count').eq('video_id', videoId).maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.is_live !== true) return res.status(400).json({ success: false, message: 'Video is not live' });

    const { data: result, error } = await supabase.rpc('like_video', { p_video_id: videoId, p_user_id: uid });
    if (error) throw error;
    return res.json({ success: true, liked: true, totalLikes: result?.total_likes ?? 0 });
  } catch (err) {
    console.error('videoPublish.likeVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function unlikeVideo(req, res) {
  try {
    if (!supabase) return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!uid)      return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!videoId)  return res.status(400).json({ success: false, message: 'videoId required' });

    const { data: video } = await supabase.from('tiktok_videos').select('video_id').eq('video_id', videoId).maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const { data: result, error } = await supabase.rpc('unlike_video', { p_video_id: videoId, p_user_id: uid });
    if (error) throw error;
    return res.json({ success: true, liked: false, totalLikes: result?.total_likes ?? 0 });
  } catch (err) {
    console.error('videoPublish.unlikeVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

// ── Comments ──────────────────────────────────────────────────────────────────

export async function addComment(req, res) {
  try {
    if (!supabase) return res.status(503).json({ success: false, message: 'Video storage is temporarily unavailable.' });
    const uid      = req.uid;
    const { videoId } = req.params;
    const text     = (req.body?.text || '').trim();
    if (!uid)      return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!videoId)  return res.status(400).json({ success: false, message: 'videoId required' });
    if (!text)     return res.status(400).json({ success: false, message: 'Comment text is required' });

    const authorName = String(req.body?.authorName || '').trim().slice(0, 64) || 'Member';

    const { data: video } = await supabase.from('tiktok_videos').select('is_live, allow_people_to_comment').eq('video_id', videoId).maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.is_live !== true) return res.status(400).json({ success: false, message: 'Video is not live' });
    if (video.allow_people_to_comment === false) return res.status(403).json({ success: false, message: 'Comments are disabled for this video' });

    const { data: inserted, error: insErr } = await supabase
      .from('tiktok_video_comments')
      .insert([{ video_id: videoId, user_id: uid, author_name: authorName, comment: text }])
      .select('id, created_at')
      .single();
    if (insErr) throw insErr;

    // Update comments_count
    const { data: videoRow } = await supabase.from('tiktok_videos').select('comments_count').eq('video_id', videoId).maybeSingle();
    const newTotal = Number(videoRow?.comments_count || 0) + 1;
    await supabase.from('tiktok_videos').update({ comments_count: newTotal }).eq('video_id', videoId);

    return res.status(201).json({
      success: true,
      comment: {
        commentId:  inserted.id,
        userId:     uid,
        authorName,
        text,
        createdAt:  new Date(inserted.created_at).getTime(),
      },
    });
  } catch (err) {
    console.error('videoPublish.addComment error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function getComments(req, res) {
  try {
    if (!supabase) return res.json({ success: true, data: [] });
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    const { data: video } = await supabase.from('tiktok_videos').select('is_live').eq('video_id', videoId).maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.is_live !== true) return res.status(404).json({ success: false, message: 'Video not available' });

    const { data, error } = await supabase
      .from('tiktok_video_comments')
      .select('id, user_id, author_name, comment, created_at')
      .eq('video_id', videoId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const list = (data || []).map((c) => ({
      commentId:  c.id,
      userId:     c.user_id,
      authorName: c.author_name || 'Member',
      text:       c.comment,
      createdAt:  new Date(c.created_at).getTime(),
    }));
    return res.json({ success: true, data: list });
  } catch (err) {
    console.error('videoPublish.getComments error', err?.message || err);
    return res.status(500).json({ success: false, data: [] });
  }
}

// ── Purchase premium video ────────────────────────────────────────────────────

export async function purchaseVideo(req, res) {
  try {
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!uid)      return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!videoId)  return res.status(400).json({ success: false, message: 'videoId required' });
    if (!supabase) return res.status(503).json({ success: false, message: 'Storage unavailable' });

    const { data: video } = await supabase
      .from('tiktok_videos')
      .select('video_id, is_live, is_premium_content, token_price')
      .eq('video_id', videoId)
      .maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (!video.is_live) return res.status(400).json({ success: false, message: 'Video not available' });
    if (!video.is_premium_content) return res.status(400).json({ success: false, message: 'Video is not premium content' });

    const tokenPrice = Number(video.token_price) || 0;

    const { data: existing } = await supabase
      .from('video_purchases')
      .select('id')
      .eq('user_id', uid)
      .eq('video_id', videoId)
      .maybeSingle();
    if (existing) return res.json({ success: true, alreadyPurchased: true, message: 'Already purchased' });

    let newTokenBalance;
    if (tokenPrice > 0) {
      const { data: newBalance, error: spendErr } = await supabase.rpc('spend_coins', {
        p_user_id: uid,
        p_amount:  tokenPrice,
      });
      if (spendErr) {
        if (/insufficient coins/i.test(spendErr.message)) {
          return res.status(402).json({ success: false, message: 'Insufficient tokens. Please purchase more tokens.' });
        }
        throw spendErr;
      }
      newTokenBalance = newBalance;
    }

    const { error: purchaseErr } = await supabase.from('video_purchases').insert([{
      user_id:     uid,
      video_id:    videoId,
      token_price: tokenPrice,
    }]);
    if (purchaseErr) throw purchaseErr;

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

export async function getVideoPurchaseStatus(req, res) {
  try {
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!uid)      return res.json({ success: true, purchased: false });
    if (!videoId)  return res.status(400).json({ success: false, message: 'videoId required' });
    if (!supabase) return res.json({ success: true, purchased: false });

    const { data } = await supabase
      .from('video_purchases')
      .select('id, purchased_at')
      .eq('user_id', uid)
      .eq('video_id', videoId)
      .maybeSingle();

    return res.json({
      success:     true,
      purchased:   !!data,
      purchasedAt: data?.purchased_at ? new Date(data.purchased_at).getTime() : null,
    });
  } catch (err) {
    console.error('videoPublish.getVideoPurchaseStatus error:', err?.message || err);
    return res.json({ success: true, purchased: false });
  }
}

// ── Like status ───────────────────────────────────────────────────────────────

export async function getLikeStatus(req, res) {
  try {
    if (!supabase) return res.json({ success: true, liked: false });
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!uid)      return res.json({ success: true, liked: false });
    if (!videoId)  return res.status(400).json({ success: false, message: 'videoId required' });

    const { data: like } = await supabase
      .from('tiktok_video_likes')
      .select('user_id')
      .eq('video_id', videoId)
      .eq('user_id', uid)
      .maybeSingle();
    return res.json({ success: true, liked: !!like });
  } catch {
    return res.json({ success: true, liked: false });
  }
}

// ── Creator level ─────────────────────────────────────────────────────────────

export async function getCreatorLevel(req, res) {
  try {
    const uid = req.uid;
    if (!uid)      return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!supabase) return res.status(503).json({ success: false, message: 'Service unavailable' });

    const [{ data: user }, { data: videos }] = await Promise.all([
      supabase.from('users').select('followers, monthly_premium_uploads, premium_upload_month').eq('id', uid).maybeSingle(),
      supabase.from('tiktok_videos').select('likes_count').eq('user_id', uid).eq('is_live', true),
    ]);

    const followers  = Number(user?.followers || 0);
    const totalLikes = (videos || []).reduce((s, v) => s + Number(v.likes_count || 0), 0);
    const level      = calculateCreatorLevel(followers, totalLikes);
    const limit      = getPremiumUploadLimit(level);
    const currentMonth = getCurrentMonth();
    const storedMonth  = user?.premium_upload_month || '';
    const uploadsUsed  = storedMonth === currentMonth ? Number(user?.monthly_premium_uploads || 0) : 0;

    const nextLevel  = level < 3 ? level + 1 : null;
    const nextConfig = nextLevel ? LEVEL_CONFIG[nextLevel] : null;

    return res.json({
      success: true,
      level,
      levelName:                LEVEL_CONFIG[level].name,
      premiumUploadLimit:       limit,
      premiumUploadsUsed:       uploadsUsed,
      premiumUploadsRemaining:  limit === -1 ? null : Math.max(0, limit - uploadsUsed),
      unlimited:                limit === -1,
      followersCount:           followers,
      totalLikes,
      nextLevel,
      nextLevelName:            nextConfig?.name || null,
      nextLevelFollowers:       nextLevel === 2 ? 1000 : nextLevel === 3 ? 10000 : null,
      nextLevelLikes:           nextLevel === 2 ? 1000 : null,
    });
  } catch (err) {
    console.error('videoPublish.getCreatorLevel error:', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}
