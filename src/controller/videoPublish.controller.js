/**
 * Secure video upload & publish — Supabase primary.
 * All video metadata, likes, comments, and purchases stored in Supabase.
 * Firebase RTDB dependency removed.
 */
import { supabase, uploadFileToBucket, getPublicUrl, VIDEO_BUCKET, IMAGE_BUCKET, isConfigured as isSupabaseConfigured } from '../config/supabase.js';
import { getFirebaseDb, getFirebaseRtdb } from '../config/firebase.js';
import { getCreatorPublicFields, mergeCreatorIntoPublicVideo } from '../utils/creatorProfile.js';
import { fetchPublishedPublicVideos, fetchPublishedVideoById } from '../utils/platformPublicFeed.js';
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
import { invalidVideoIdResponse, isValidPlatformVideoId } from '../utils/videoIdValidation.js';
import { getPathSafeVideoId } from '../utils/videoPathId.js';
import { annotatePlayableVideo, validateVideoPlaybackSource } from '../utils/videoPlaybackValidation.js';
import { validateEmbedWithProbe } from '../services/videoSourceProbe.service.js';
import { creditCoins as creditCoinWallet, spendCoins as debitCoinWallet } from '../services/coinWallet.service.js';

async function resolvePlaybackValidation(videoInput) {
  const base = validateVideoPlaybackSource(videoInput);
  if (base.embedAllowed === true && base.playbackUrl) {
    return validateEmbedWithProbe(base.playbackUrl);
  }
  return base;
}

const CONSENT_QUESTION = 'Do you confirm you have permission to post this video?';

// ── Supabase row → API response shape ─────────────────────────────────────────

function isPubliclyListedRow(row) {
  return !!(row && (row.is_live === true || row.status === 'published'));
}

function applyPublicListingFilter(query) {
  return query.or('is_live.eq.true,status.eq.published');
}

function mapVideo(row) {
  const resolvedDuration =
    Number(row.duration_seconds ?? row.duration ?? row.duration_sec ?? 0) || 0;
  return annotatePlayableVideo({
    id:                     row.video_id,
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
    durationSeconds:        resolvedDuration,
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
    source:                 'community',
    playable:               row.playable,
    sourceType:             row.source_type,
    embedAllowed:           row.embed_allowed,
    validationStatus:       row.validation_status,
    playbackUrl:            row.playback_url,
  });
}

function isMissingColumnError(err, columnName) {
  const msg = String(err?.message || '');
  return (
    err?.code === 'PGRST204' ||
    err?.code === '42703' ||
    (columnName && msg.includes(`'${columnName}'`)) ||
    /schema cache|Could not find the .* column/i.test(msg)
  );
}

function extractMissingColumnName(err) {
  const msg = String(err?.message || '');
  const quoted = msg.match(/'([^']+)'/);
  if (quoted?.[1]) return quoted[1];
  const named = msg.match(/column\s+["']?([a-zA-Z0-9_]+)["']?/i);
  if (named?.[1]) return named[1];
  return null;
}

async function insertPublishedVideoRow(baseRow, durationSeconds) {
  const attempts = [
    { ...baseRow, duration: durationSeconds },
    { ...baseRow, duration_seconds: durationSeconds },
    { ...baseRow },
  ];

  let lastError = null;
  for (let i = 0; i < attempts.length; i += 1) {
    let row = { ...attempts[i] };
    for (let j = 0; j < 12; j += 1) {
      const { error } = await supabase.from('tiktok_videos').insert([row]);
      if (!error) return;
      lastError = error;
      const missingColumn = extractMissingColumnName(error);
      if (!missingColumn || !(missingColumn in row)) {
        if (
          isMissingColumnError(error, 'duration') ||
          isMissingColumnError(error, 'duration_seconds')
        ) {
          continue;
        }
        throw error;
      }
      // Remove unknown column and retry so legacy schemas still publish.
      delete row[missingColumn];
    }
  }
  throw lastError || new Error('Failed to insert video row');
}

// ── Premium upload gate ────────────────────────────────────────────────────────

async function checkPremiumUploadGate(uid) {
  try {
    if (!supabase) return { allowed: true };

    const [{ data: user }, { data: videos }] = await Promise.all([
      supabase.from('users').select('followers, monthly_premium_uploads, premium_upload_month').eq('id', uid).maybeSingle(),
      supabase.from('tiktok_videos').select('likes_count').eq('user_id', uid).or('is_live.eq.true,status.eq.published'),
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
    const embedUrl = String(req.body?.embedUrl || req.body?.embed_url || '').trim();
    const playbackValidation = await resolvePlaybackValidation({
      source: 'community',
      streamUrl: videoUrl,
      videoUrl,
      embedUrl: embedUrl || undefined,
    });
    if (playbackValidation.playable !== true) {
      return res.status(400).json({
        success: false,
        message: 'Video source cannot be played inside the platform.',
        reason: playbackValidation.reason,
      });
    }

    const { creatorDisplayName, creatorAvatarUrl } = await getCreatorPublicFields(uid);
    const videoId = crypto.randomUUID();
    const isLive  = consentGiven;

    const insertRow = {
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
      is_live:                  isLive,
      is_premium_content:       isPremiumContent,
      token_price:              tokenPrice,
      consent_given:            consentGiven,
      creator_display_name:     creatorDisplayName || null,
      creator_avatar_url:       creatorAvatarUrl   || null,
      status:                   isLive ? 'published' : 'draft',
      playable:                 playbackValidation.playable,
      source_type:              playbackValidation.sourceType,
      embed_allowed:            playbackValidation.embedAllowed,
      validation_status:        playbackValidation.validationStatus,
      playback_url:             playbackValidation.playbackUrl,
    };
    await insertPublishedVideoRow(insertRow, durationSeconds);

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
    const embedUrl = String(req.body?.embedUrl || req.body?.embed_url || '').trim();
    const playbackValidation = await resolvePlaybackValidation({
      source: 'community',
      streamUrl: videoUrl,
      videoUrl,
      embedUrl: embedUrl || undefined,
    });
    if (playbackValidation.playable !== true) {
      return res.status(400).json({
        success: false,
        message: 'Video source cannot be played inside the platform.',
        reason: playbackValidation.reason,
      });
    }

    const insertRow = {
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
      is_live:                  isLive,
      is_premium_content:       isPremiumContent,
      token_price:              tokenPrice,
      consent_given:            consentGiven,
      creator_display_name:     creatorDisplayName || null,
      creator_avatar_url:       creatorAvatarUrl   || null,
      status:                   isLive ? 'published' : 'draft',
      playable:                 playbackValidation.playable,
      source_type:              playbackValidation.sourceType,
      embed_allowed:            playbackValidation.embedAllowed,
      validation_status:        playbackValidation.validationStatus,
      playback_url:             playbackValidation.playbackUrl,
    };
    await insertPublishedVideoRow(insertRow, durationSeconds);

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
    const premiumOnly = req.query?.premium === 'true';
    const limit = Math.min(Math.max(parseInt(req.query?.limit || '100', 10) || 100, 1), 200);
    const page = Math.max(1, parseInt(req.query?.page || '1', 10) || 1);
    const data = await fetchPublishedPublicVideos({ page, limit, premiumOnly });
    return res.json({ success: true, data });
  } catch (err) {
    console.error('videoPublish.getPublicVideos error', err?.message || err);
    return res.status(500).json({ success: false, data: [], message: err?.message || 'Failed' });
  }
}

// ── Single video ──────────────────────────────────────────────────────────────

export async function getVideoById(req, res) {
  try {
    const { videoId }     = req.params;
    const requesterUid    = req.uid;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res, { data: null });
    if (!supabase) {
      const fallback = await fetchPublishedVideoById(videoId, requesterUid || null);
      if (fallback) return res.json({ success: true, data: fallback });
      return res.status(503).json({ success: false, message: 'Video feed is temporarily unavailable.' });
    }

    const { data, error } = await supabase
      .from('tiktok_videos')
      .select('*')
      .eq('video_id', videoId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const fallback = await fetchPublishedVideoById(videoId, requesterUid || null);
      if (fallback) return res.json({ success: true, data: fallback });
      return res.status(404).json({ success: false, message: 'Video not found' });
    }

    if (!isPubliclyListedRow(data)) {
      const isOwner = requesterUid && data.user_id === requesterUid;
      if (!isOwner) return res.status(404).json({ success: false, message: 'Video not available' });
    }
    const mapped = mapVideo(data);
    if (mapped.playable !== true) {
      return res.status(404).json({
        success: false,
        message: 'This video is unavailable for in-platform playback.',
      });
    }
    const merged = await mergeCreatorIntoPublicVideo(mapped);
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
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

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
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

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

    const urlFields = ['stream_url', 'storage_url', 'embed_url'];
    const urlTouched = urlFields.some((f) => req.body?.[f] !== undefined);
    if (urlTouched) {
      const playbackValidation = await resolvePlaybackValidation({
        source: 'community',
        streamUrl: req.body?.stream_url ?? video.stream_url ?? video.storage_url,
        storage_url: req.body?.storage_url ?? video.storage_url,
        videoUrl: req.body?.storage_url ?? video.storage_url,
        embedUrl: req.body?.embed_url ?? video.embed_url,
      });
      updates.playable = playbackValidation.playable;
      updates.source_type = playbackValidation.sourceType;
      updates.embed_allowed = playbackValidation.embedAllowed;
      updates.validation_status = playbackValidation.validationStatus;
      updates.playback_url = playbackValidation.playbackUrl || null;
    }

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
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

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
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

    const { data: video } = await supabase.from('tiktok_videos').select('is_live, status, likes_count').eq('video_id', videoId).maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (!isPubliclyListedRow(video)) return res.status(400).json({ success: false, message: 'Video is not live' });

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
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

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
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    if (!text)     return res.status(400).json({ success: false, message: 'Comment text is required' });

    const authorName = String(req.body?.authorName || '').trim().slice(0, 64) || 'Member';

    const { data: video } = await supabase.from('tiktok_videos').select('is_live, status, allow_people_to_comment').eq('video_id', videoId).maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (!isPubliclyListedRow(video)) return res.status(400).json({ success: false, message: 'Video is not live' });
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
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res, { data: [] });

    const { data: video } = await supabase.from('tiktok_videos').select('is_live, status').eq('video_id', videoId).maybeSingle();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (!isPubliclyListedRow(video)) return res.status(404).json({ success: false, message: 'Video not available' });

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

const PUBLIC_VIDEO_PURCHASES_TABLE = 'public_video_purchases';

function isMissingRelationError(err) {
  const msg = String(err?.message || '');
  return (
    err?.code === '42P01' ||
    err?.code === 'PGRST200' ||
    /schema cache|Could not find the table|does not exist/i.test(msg)
  );
}

function isDuplicatePurchaseError(err) {
  return err?.code === '23505' || /duplicate key|already exists/i.test(String(err?.message || ''));
}

function getPurchaseVideoId(row = {}) {
  return String(row.video_id || row.videoId || row.id || '').trim();
}

function normalizePurchasablePublicVideo(row = {}, fallbackId = '') {
  const publicVideoId = getPurchaseVideoId(row) || String(fallbackId || '').trim();
  const tokenPrice = Number(
    row.token_price ??
    row.tokenPrice ??
    row.coin_price ??
    row.coinPrice ??
    0
  ) || 0;
  const isPremiumContent =
    row.is_premium_content === true ||
    row.isPremiumContent === true ||
    row.isPremium === true ||
    row.premium === true ||
    tokenPrice > 0;

  return {
    publicVideoId,
    tiktokVideoId: row.video_id && isValidPlatformVideoId(String(row.video_id)) ? String(row.video_id) : null,
    source: String(row.source || (row.video_id ? 'community' : 'public')).toLowerCase(),
    userId: row.user_id || row.userId || null,
    title: row.title || '',
    isPremiumContent,
    tokenPrice,
    publiclyListed: row.video_id ? isPubliclyListedRow(row) : row.isLive !== false,
  };
}

async function resolvePurchasablePublicVideo(videoId) {
  const lookup = String(videoId || '').trim();
  if (!lookup || !isValidPlatformVideoId(lookup)) return null;

  if (supabase) {
    const { data, error } = await supabase
      .from('tiktok_videos')
      .select('video_id, user_id, title, is_live, status, is_premium_content, token_price')
      .eq('video_id', lookup)
      .maybeSingle();
    if (error && !isMissingRelationError(error)) throw error;
    if (data) return normalizePurchasablePublicVideo(data, lookup);

    const media = await supabase
      .from('media')
      .select('*')
      .eq('id', lookup)
      .maybeSingle();
    if (media.error && !isMissingRelationError(media.error)) throw media.error;
    if (media.data) return normalizePurchasablePublicVideo({ ...media.data, source: 'media' }, lookup);
  }

  const rtdb = getFirebaseRtdb();
  if (rtdb) {
    const [videoSnap, mediaSnap] = await Promise.all([
      rtdb.ref(`videos/${lookup}`).once('value'),
      rtdb.ref(`media/${lookup}`).once('value'),
    ]);
    if (videoSnap.exists()) {
      return normalizePurchasablePublicVideo({ ...(videoSnap.val() || {}), id: lookup, source: 'rtdb' }, lookup);
    }
    if (mediaSnap.exists()) {
      return normalizePurchasablePublicVideo({ ...(mediaSnap.val() || {}), id: lookup, source: 'media' }, lookup);
    }
  }

  const rows = await fetchPublishedPublicVideos({ page: 1, limit: 500, premiumOnly: false });
  const match = rows.find((row) => {
    const id = getPurchaseVideoId(row);
    return id === lookup || getPathSafeVideoId(id) === lookup;
  });
  return match ? normalizePurchasablePublicVideo(match, lookup) : null;
}

async function hasSupabaseTiktokPurchase(uid, videoId) {
  if (!supabase || !uid || !videoId) return null;
  const { data, error } = await supabase
    .from('video_purchases')
    .select('id, purchased_at')
    .eq('user_id', uid)
    .eq('video_id', videoId)
    .maybeSingle();
  if (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
  return data || null;
}

async function hasGenericPublicPurchase(uid, publicVideoId) {
  if (!uid || !publicVideoId) return null;
  if (supabase) {
    const { data, error } = await supabase
      .from(PUBLIC_VIDEO_PURCHASES_TABLE)
      .select('id, purchased_at')
      .eq('user_id', uid)
      .eq('public_video_id', publicVideoId)
      .maybeSingle();
    if (error) {
      if (!isMissingRelationError(error)) throw error;
    } else if (data) {
      return data;
    }
  }

  const rtdb = getFirebaseRtdb();
  if (!rtdb) return null;
  const snap = await rtdb.ref(`videoPurchases/${uid}/${publicVideoId}`).once('value');
  return snap.exists() ? { id: publicVideoId, ...(snap.val() || {}) } : null;
}

async function findExistingPurchase(uid, video) {
  if (!uid || !video) return null;
  if (video.tiktokVideoId) {
    const tiktokPurchase = await hasSupabaseTiktokPurchase(uid, video.tiktokVideoId);
    if (tiktokPurchase) return tiktokPurchase;
  }
  return hasGenericPublicPurchase(uid, video.publicVideoId);
}

async function spendSupabaseCoins(uid, amount) {
  const price = Number(amount) || 0;
  if (!price) return { newBalance: undefined, source: 'none' };
  if (!supabase) throw new Error('Token wallet is temporarily unavailable.');

  try {
    const result = await debitCoinWallet({
      userId: uid,
      amount: price,
      type: 'spend',
      sourceType: 'premium_video',
      metadata: { reason: 'premium_video_purchase' },
    });
    return { newBalance: Number(result.balance), source: 'coin_wallet' };
  } catch (walletError) {
    if (/insufficient/i.test(String(walletError?.message || ''))) {
      const err = new Error('Insufficient tokens. Please purchase more tokens.');
      err.statusCode = 402;
      throw err;
    }
    console.warn('[videoPurchase] coin wallet spend failed, trying legacy path:', walletError?.message || walletError);
  }

  const rpc = await supabase.rpc('spend_coins', {
    p_user_id: uid,
    p_amount:  price,
  });
  if (!rpc.error) return { newBalance: Number(rpc.data), source: 'supabase' };
  if (!/function .*spend_coins|could not find|schema cache/i.test(String(rpc.error?.message || ''))) {
    if (/insufficient coins/i.test(rpc.error.message)) {
      const err = new Error('Insufficient tokens. Please purchase more tokens.');
      err.statusCode = 402;
      throw err;
    }
  }

  const { data: userRow, error: readErr } = await supabase
    .from('users')
    .select('coin_balance')
    .eq('id', uid)
    .maybeSingle();
  if (readErr) throw readErr;
  const current = Number(userRow?.coin_balance ?? 0);
  if (current < price) {
    const err = new Error('Insufficient tokens. Please purchase more tokens.');
    err.statusCode = 402;
    throw err;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('users')
    .update({ coin_balance: current - price })
    .eq('id', uid)
    .gte('coin_balance', price)
    .select('coin_balance')
    .maybeSingle();
  if (updateErr) throw updateErr;
  if (!updated) {
    const err = new Error('Insufficient tokens. Please try again.');
    err.statusCode = 402;
    throw err;
  }
  return { newBalance: Number(updated.coin_balance), source: 'supabase' };
}

async function spendFirebaseCoins(uid, amount) {
  const price = Number(amount) || 0;
  if (!price) return { newBalance: undefined, source: 'none' };

  const firestore = getFirebaseDb();
  if (firestore) {
    const ref = firestore.collection('users').doc(uid);
    let nextBalance = null;
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() || {} : {};
      const current = Number(data.coinBalance ?? data.tokenBalance ?? data.coin_balance ?? 0);
      if (current < price) {
        const err = new Error('Insufficient tokens. Please purchase more tokens.');
        err.statusCode = 402;
        throw err;
      }
      nextBalance = current - price;
      tx.set(ref, { coinBalance: nextBalance, tokenBalance: nextBalance }, { merge: true });
    });
    const rtdb = getFirebaseRtdb();
    if (rtdb) {
      rtdb.ref(`users/${uid}`).update({ coinBalance: nextBalance, tokenBalance: nextBalance }).catch(() => {});
    }
    if (supabase) {
      supabase.from('users').upsert({ id: uid, coin_balance: nextBalance }, { onConflict: 'id' }).then(() => {}, () => {});
    }
    return { newBalance: Number(nextBalance), source: 'firebase' };
  }

  const rtdb = getFirebaseRtdb();
  if (!rtdb) throw new Error('Token wallet is temporarily unavailable.');
  const ref = rtdb.ref(`users/${uid}`);
  let nextBalance = null;
  const result = await ref.transaction((current) => {
    const data = current && typeof current === 'object' ? current : {};
    const currentBalance = Number(data.coinBalance ?? data.tokenBalance ?? data.coin_balance ?? 0);
    if (currentBalance < price) return;
    nextBalance = currentBalance - price;
    return { ...data, coinBalance: nextBalance, tokenBalance: nextBalance };
  });
  if (!result.committed) {
    const err = new Error('Insufficient tokens. Please purchase more tokens.');
    err.statusCode = 402;
    throw err;
  }
  if (supabase) {
    supabase.from('users').upsert({ id: uid, coin_balance: nextBalance }, { onConflict: 'id' }).then(() => {}, () => {});
  }
  return { newBalance: Number(nextBalance), source: 'firebase' };
}

async function spendCoinsForVideoPurchase(uid, amount) {
  try {
    return await spendSupabaseCoins(uid, amount);
  } catch (err) {
    const status = Number(err?.statusCode || 0);
    const canTryFirebase = Boolean(getFirebaseRtdb() || getFirebaseDb());
    if ((status === 402 || /insufficient tokens|insufficient coins/i.test(String(err?.message || ''))) && canTryFirebase) {
      return spendFirebaseCoins(uid, amount);
    }
    throw err;
  }
}

async function refundCoins(uid, amount, source) {
  const price = Number(amount) || 0;
  if (!uid || !price) return;
  if (source === 'firebase') {
    const firestore = getFirebaseDb();
    if (firestore) {
      const ref = firestore.collection('users').doc(uid);
      await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() || {} : {};
        const current = Number(data.coinBalance ?? data.tokenBalance ?? data.coin_balance ?? 0);
        const next = current + price;
        tx.set(ref, { coinBalance: next, tokenBalance: next }, { merge: true });
      }).catch(() => {});
    }
    const rtdb = getFirebaseRtdb();
    if (rtdb) {
      const ref = rtdb.ref(`users/${uid}`);
      await ref.transaction((current) => {
        const data = current && typeof current === 'object' ? current : {};
        const currentBalance = Number(data.coinBalance ?? data.tokenBalance ?? data.coin_balance ?? 0);
        return { ...data, coinBalance: currentBalance + price, tokenBalance: currentBalance + price };
      }).catch(() => {});
    }
    return;
  }

  if (!supabase) return;
  try {
    await creditCoinWallet({
      userId: uid,
      amount: price,
      type: 'refund',
      sourceType: 'premium_video_refund',
      metadata: { source },
    });
    return;
  } catch (_) {}
  const rpc = await supabase.rpc('add_coins', { p_user_id: uid, p_amount: price });
  if (!rpc.error) return;
  const { data } = await supabase.from('users').select('coin_balance').eq('id', uid).maybeSingle();
  const next = (Number(data?.coin_balance) || 0) + price;
  await supabase.from('users').upsert({ id: uid, coin_balance: next }, { onConflict: 'id' }).catch(() => {});
}

async function recordGenericPurchase(uid, video, tokenPrice) {
  if (supabase) {
    const { error } = await supabase.from(PUBLIC_VIDEO_PURCHASES_TABLE).insert({
      user_id: uid,
      public_video_id: video.publicVideoId,
      video_source: video.source || 'public',
      creator_id: video.userId || null,
      token_price: tokenPrice,
      metadata: {
        title: video.title || '',
        tiktokVideoId: video.tiktokVideoId || null,
      },
    });
    if (!error) return;
    if (isDuplicatePurchaseError(error)) {
      const err = new Error('Already purchased');
      err.code = 'ALREADY_PURCHASED';
      throw err;
    }
    if (!isMissingRelationError(error)) throw error;
  }

  const rtdb = getFirebaseRtdb();
  if (!rtdb) throw new Error('Purchase storage is not configured.');
  const ref = rtdb.ref(`videoPurchases/${uid}/${video.publicVideoId}`);
  const snap = await ref.once('value');
  if (snap.exists()) {
    const err = new Error('Already purchased');
    err.code = 'ALREADY_PURCHASED';
    throw err;
  }
  await ref.set({
    publicVideoId: video.publicVideoId,
    videoSource: video.source || 'public',
    creatorId: video.userId || null,
    tokenPrice,
    purchasedAt: new Date().toISOString(),
    title: video.title || '',
  });
}

async function recordVideoPurchase(uid, video, tokenPrice) {
  if (video.tiktokVideoId && supabase) {
    const { error } = await supabase.from('video_purchases').insert([{
      user_id:     uid,
      video_id:    video.tiktokVideoId,
      token_price: tokenPrice,
    }]);
    if (!error) return;
    if (isDuplicatePurchaseError(error)) {
      const err = new Error('Already purchased');
      err.code = 'ALREADY_PURCHASED';
      throw err;
    }
    if (!isMissingRelationError(error)) throw error;
  }
  await recordGenericPurchase(uid, video, tokenPrice);
}

// ── Purchase premium video ────────────────────────────────────────────────────

export async function purchaseVideo(req, res) {
  try {
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!uid)      return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

    const video = await resolvePurchasablePublicVideo(videoId);
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (!video.publiclyListed) return res.status(400).json({ success: false, message: 'Video not available' });
    if (!video.isPremiumContent) return res.status(400).json({ success: false, message: 'Video is not premium content' });

    const tokenPrice = Number(video.tokenPrice) || 0;

    const existing = await findExistingPurchase(uid, video);
    if (existing) return res.json({ success: true, alreadyPurchased: true, message: 'Already purchased' });

    const spend = await spendCoinsForVideoPurchase(uid, tokenPrice);
    try {
      await recordVideoPurchase(uid, video, tokenPrice);
      const { completePremiumVideoPurchase } = await import('../services/premiumVideoPurchase.service.js');
      const result = await completePremiumVideoPurchase({
        userId: uid,
        video,
        tokenPrice,
        paymentReference: spend.source ? `wallet:${spend.source}:${Date.now()}` : null,
        req,
      });
      if (result.duplicate) {
        return res.json({ success: true, alreadyPurchased: true, message: 'Already purchased' });
      }
      return res.json({
        success: true,
        message: 'Purchase successful',
        purchase: {
          id: result.purchase?.id,
          creatorEarningsUsd: result.split?.creatorEarningsUsd,
          platformEarningsUsd: result.split?.platformFeeUsd,
          purchaseAmountUsd: result.purchaseAmountUsd,
        },
        ...(spend.newBalance !== undefined ? { newTokenBalance: spend.newBalance } : {}),
      });
    } catch (err) {
      await refundCoins(uid, tokenPrice, spend.source);
      if (err?.code === 'ALREADY_PURCHASED') {
        return res.json({ success: true, alreadyPurchased: true, message: 'Already purchased' });
      }
      throw err;
    }
  } catch (err) {
    console.error('videoPublish.purchaseVideo error:', err?.message || err);
    return res.status(err?.statusCode || 500).json({ success: false, message: err?.message || 'Purchase failed' });
  }
}

export async function getVideoPurchaseStatus(req, res) {
  try {
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!uid)      return res.json({ success: true, purchased: false });
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

    const video = await resolvePurchasablePublicVideo(videoId);
    if (!video) return res.json({ success: true, purchased: false });
    const { findPremiumPurchase } = await import('../services/premiumVideoPurchase.service.js');
    const premiumRow = await findPremiumPurchase(uid, video.publicVideoId);
    const data = premiumRow || (await findExistingPurchase(uid, video));

    return res.json({
      success:     true,
      purchased:   !!data,
      purchasedAt: data?.purchased_at
        ? new Date(data.purchased_at).getTime()
        : data?.purchasedAt
          ? new Date(data.purchasedAt).getTime()
          : null,
    });
  } catch (err) {
    console.error('videoPublish.getVideoPurchaseStatus error:', err?.message || err);
    return res.json({ success: true, purchased: false });
  }
}

// ── Like status ───────────────────────────────────────────────────────────────

export async function getPurchasedVideosLibrary(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { listUserPurchasedVideos } = await import('../services/premiumVideoPurchase.service.js');
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = req.query.search || '';
    const result = await listUserPurchasedVideos(uid, { page, limit, search });
    return res.json({ success: true, data: result.data, meta: result.meta });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function getPurchaseReceipt(req, res) {
  try {
    const uid = req.uid;
    const { purchaseId } = req.params;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { getPurchaseReceipt: loadReceipt } = await import('../services/premiumVideoPurchase.service.js');
    const receipt = await loadReceipt(uid, purchaseId);
    if (!receipt) return res.status(404).json({ success: false, message: 'Receipt not found' });
    return res.json({ success: true, receipt });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function updateWatchProgress(req, res) {
  try {
    const uid = req.uid;
    const { videoId } = req.params;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    const { saveWatchProgress } = await import('../services/premiumVideoPurchase.service.js');
    const row = await saveWatchProgress(
      uid,
      videoId,
      req.body?.progressSeconds,
      req.body?.durationSeconds,
    );
    if (!row) return res.status(403).json({ success: false, message: 'No access to this video' });
    return res.json({ success: true, progress: row });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function getLikeStatus(req, res) {
  try {
    if (!supabase) return res.json({ success: true, liked: false, totalLikes: 0, totalComments: 0 });
    const uid      = req.uid;
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res, { liked: false });

    const { data: vrow } = await supabase
      .from('tiktok_videos')
      .select('likes_count, comments_count')
      .eq('video_id', videoId)
      .maybeSingle();
    const totalLikes = Number(vrow?.likes_count ?? 0) || 0;
    const totalComments = Number(vrow?.comments_count ?? 0) || 0;

    if (!uid) return res.json({ success: true, liked: false, totalLikes, totalComments });

    const { data: like } = await supabase
      .from('tiktok_video_likes')
      .select('user_id')
      .eq('video_id', videoId)
      .eq('user_id', uid)
      .maybeSingle();
    return res.json({ success: true, liked: !!like, totalLikes, totalComments });
  } catch {
    return res.json({ success: true, liked: false, totalLikes: 0, totalComments: 0 });
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
      supabase.from('tiktok_videos').select('likes_count').eq('user_id', uid).or('is_live.eq.true,status.eq.published'),
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
