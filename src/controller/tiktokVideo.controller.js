/**
 * TikTok-style video system: Supabase Storage + Postgres (tiktok_videos, video_likes, views, comments).
 * Firebase Auth only for user_id; all writes go through this backend with requireAuth where needed.
 */
import crypto from 'crypto';
import { supabase, uploadFileToBucket, getPublicUrl, VIDEO_BUCKET, isConfigured as isSupabaseConfigured } from '../config/supabase.js';
import { ensureVideoFilenameForStorage, resolveVideoContentType } from '../utils/videoStorage.js';
import { creditViewMilestone } from './earnings.controller.js';
import { invalidVideoIdResponse, isValidPlatformVideoId } from '../utils/videoIdValidation.js';
import { annotatePlayableVideo, filterPlayableVideos, validateVideoPlaybackSource } from '../utils/videoPlaybackValidation.js';
import { getPlatformSettingsMap } from '../services/platformSettings.service.js';

const VIDEOS_TABLE = 'tiktok_videos';
const LIKES_TABLE = 'tiktok_video_likes';
const COMMENTS_TABLE = 'tiktok_video_comments';
const PLAY_HISTORY_TABLE = 'video_play_history';
const ADS_TABLE = 'video_ads';
const AD_IMPRESSIONS_TABLE = 'video_ad_impressions';

function ensureSupabase() {
  if (!isSupabaseConfigured() || !supabase) throw new Error('Supabase not configured');
}

function hashValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const salt = process.env.ENGAGEMENT_HASH_SALT || process.env.JWT_SECRET || 'xstream-engagement';
  return crypto.createHash('sha256').update(`${salt}:${raw}`).digest('hex');
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}

function cleanCommentText(value) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function extractMissingColumnName(error) {
  const msg = String(error?.message || '');
  const quoted = msg.match(/'([^']+)'/);
  if (quoted?.[1]) return quoted[1];
  const named = msg.match(/column\s+["']?([a-zA-Z0-9_]+)["']?/i);
  return named?.[1] || null;
}

async function insertVideoRowWithFallback(row) {
  let attempt = { ...row };
  let lastError = null;
  for (let i = 0; i < 12; i += 1) {
    const { error } = await supabase.from(VIDEOS_TABLE).insert(attempt);
    if (!error) return;
    lastError = error;
    const missingColumn = extractMissingColumnName(error);
    if (!missingColumn || !(missingColumn in attempt)) throw error;
    delete attempt[missingColumn];
  }
  throw lastError || new Error('Failed to insert video row');
}

async function buildWatermarkMetadata() {
  try {
    const settings = await getPlatformSettingsMap();
    const enabled = String(settings.video_watermark_enabled ?? 'true').toLowerCase() !== 'false';
    const burnInEnabled = String(settings.video_watermark_burn_in_enabled ?? 'true').toLowerCase() !== 'false';
    return {
      watermark_required: enabled && burnInEnabled,
      watermark_burned_in: false,
      watermark_updated_at: new Date().toISOString(),
      watermark_config: {
        logoUrl: settings.video_watermark_logo_url || settings.platform_logo_url || '/logo1.png',
        position: settings.video_watermark_position || 'bottom-right',
        sizePx: Number(settings.video_watermark_size_px || 92) || 92,
        opacity: Number(settings.video_watermark_opacity || 0.72) || 0.72,
        marginPx: Number(settings.video_watermark_margin_px || 16) || 16,
      },
    };
  } catch (_) {
    return {
      watermark_required: true,
      watermark_burned_in: false,
      watermark_updated_at: new Date().toISOString(),
      watermark_config: { logoUrl: '/logo1.png', position: 'bottom-right', sizePx: 92, opacity: 0.72, marginPx: 16 },
    };
  }
}

/**
 * Upload video to Supabase Storage and insert metadata into tiktok_videos.
 * req.uid from Firebase auth; req.file from multer; body: title, description.
 */
export async function uploadVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });

    const file = req.file;
    const title = (req.body?.title || '').trim() || 'Untitled';
    const description = (req.body?.description || '').trim();

    if (!file) return res.status(400).json({ success: false, message: 'Video file is required' });

    ensureSupabase();

    const videoId = crypto.randomUUID();
    const timestamp = Date.now();
    const safeName = ensureVideoFilenameForStorage(file.originalname, file.mimetype);
    const storagePath = `tiktok/${uid}/${timestamp}-${safeName}`;
    const contentType = resolveVideoContentType(file.mimetype, safeName);

    const data = await uploadFileToBucket(VIDEO_BUCKET, storagePath, file, contentType);
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const storageUrl =
      getPublicUrl(VIDEO_BUCKET, data.path) ||
      (baseUrl
        ? `${baseUrl}/storage/v1/object/public/${VIDEO_BUCKET}/${data.path.split('/').map(encodeURIComponent).join('/')}`
        : '');

    const playbackValidation = validateVideoPlaybackSource({
      source: 'community',
      streamUrl: storageUrl,
      storage_url: storageUrl,
      videoUrl: storageUrl,
    });
    if (playbackValidation.playable !== true) {
      return res.status(400).json({
        success: false,
        message: 'Video source cannot be played inside the platform.',
        reason: playbackValidation.reason,
      });
    }

    await insertVideoRowWithFallback({
      video_id: videoId,
      user_id: uid,
      storage_url: storageUrl,
      stream_url: storageUrl,
      title,
      description,
      status: 'published',
      is_live: true,
      likes_count: 0,
      views_count: 0,
      comments_count: 0,
      playable: playbackValidation.playable,
      source_type: playbackValidation.sourceType,
      embed_allowed: playbackValidation.embedAllowed,
      validation_status: playbackValidation.validationStatus,
      playback_url: playbackValidation.playbackUrl,
      ...(await buildWatermarkMetadata()),
    });

    return res.status(201).json({
      success: true,
      videoId,
      storageUrl,
      title,
      message: 'Video uploaded',
    });
  } catch (err) {
    console.error('tiktokVideo.uploadVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Upload failed' });
  }
}

/**
 * Feed: list videos with counts, order by created_at desc, paginated.
 */
export async function getFeed(req, res) {
  try {
    ensureSupabase();

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const { data, error } = await supabase
      .from(VIDEOS_TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const videos = data || [];
    const userIds = [...new Set(videos.map(v => v.user_id).filter(Boolean))];
    let usernameMap = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase.from('users').select('id, username').in('id', userIds);
      if (users) users.forEach(u => { usernameMap[u.id] = u.username; });
    }
    const enriched = filterPlayableVideos(
      videos.map((v) =>
        annotatePlayableVideo({
          ...v,
          id: v.video_id,
          streamUrl: v.stream_url || v.storage_url,
          source: 'community',
          creator_username: usernameMap[v.user_id] || null,
        }),
      ),
    );

    return res.json({ success: true, data: enriched, page, limit });
  } catch (err) {
    console.error('tiktokVideo.getFeed error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed', data: [] });
  }
}

/**
 * Videos by creator (user_id).
 */
export async function getVideosByUser(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });

    ensureSupabase();

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const { data, error } = await supabase
      .from(VIDEOS_TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const videos = data || [];
    let creatorUsername = null;
    if (userId) {
      const { data: u } = await supabase.from('users').select('username').eq('id', userId).maybeSingle();
      creatorUsername = u?.username || null;
    }
    const enriched = videos.map(v => ({ ...v, creator_username: creatorUsername }));

    return res.json({ success: true, data: enriched, page, limit });
  } catch (err) {
    console.error('tiktokVideo.getVideosByUser error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed', data: [] });
  }
}

/**
 * Single video by video_id.
 */
export async function getVideo(req, res) {
  try {
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res, { data: [] });

    ensureSupabase();

    const { data, error } = await supabase
      .from(VIDEOS_TABLE)
      .select('*')
      .eq('video_id', videoId)
      .single();

    if (error || !data) return res.status(404).json({ success: false, message: 'Video not found' });

    const mapped = annotatePlayableVideo({
      ...data,
      id: data.video_id,
      streamUrl: data.stream_url || data.storage_url,
      source: 'community',
    });
    if (mapped.playable !== true) {
      return res.status(404).json({
        success: false,
        message: 'This video is unavailable for in-platform playback.',
      });
    }

    return res.json({ success: true, data: mapped });
  } catch (err) {
    console.error('tiktokVideo.getVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Like: insert into video_likes and increment likes_count. Idempotent (ignore if already liked).
 */
export async function likeVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

    ensureSupabase();

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('likes_count').eq('video_id', videoId).single();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const { data: result, error } = await supabase.rpc('like_video', {
      p_video_id: videoId,
      p_user_id: uid,
    });
    if (error) throw error;

    return res.json({ success: true, liked: true, likesCount: result?.total_likes || 0, duplicate: result?.duplicate === true });
  } catch (err) {
    console.error('tiktokVideo.likeVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Unlike: delete from video_likes and decrement likes_count. Prevent negative.
 */
export async function unlikeVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

    ensureSupabase();

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('likes_count').eq('video_id', videoId).single();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const { data: result, error } = await supabase.rpc('unlike_video', {
      p_video_id: videoId,
      p_user_id: uid,
    });
    if (error) throw error;

    return res.json({ success: true, liked: false, likesCount: result?.total_likes || 0, duplicate: result?.duplicate === true });
  } catch (err) {
    console.error('tiktokVideo.unlikeVideo error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Get like status for current user.
 */
export async function getLikeStatus(req, res) {
  try {
    const uid = req.uid;
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res, { liked: false, likesCount: 0, commentsCount: 0 });

    ensureSupabase();

    const { data: vrow } = await supabase
      .from(VIDEOS_TABLE)
      .select('likes_count, comments_count')
      .eq('video_id', videoId)
      .maybeSingle();
    const likesCount = Math.max(0, Number(vrow?.likes_count ?? 0));
    const commentsCount = Math.max(0, Number(vrow?.comments_count ?? 0));

    if (!uid) {
      return res.json({ success: true, liked: false, likesCount, commentsCount });
    }

    const { data } = await supabase.from(LIKES_TABLE).select('video_id').eq('video_id', videoId).eq('user_id', uid).maybeSingle();
    return res.json({ success: true, liked: !!data, likesCount, commentsCount });
  } catch (err) {
    return res.json({ success: true, liked: false, likesCount: 0, commentsCount: 0 });
  }
}

/**
 * Record view: one per user or session. Increment views_count only on new view.
 */
export async function recordView(req, res) {
  try {
    const uid = req.uid || null;
    const sessionId = String(req.body?.session_id || req.body?.sessionId || req.query?.session_id || '').trim() || null;
    const fingerprint = String(req.body?.fingerprint || req.query?.fingerprint || '').trim().slice(0, 160) || null;
    const watchSeconds = Math.max(0, Math.min(86400, Number(req.body?.watchSeconds ?? req.body?.watch_seconds ?? 0) || 0));
    const durationSeconds = Math.max(0, Number(req.body?.durationSeconds ?? req.body?.duration_seconds ?? 0) || 0);
    const rawProgress = Number(req.body?.progressRatio ?? req.body?.progress_ratio ?? 0) || 0;
    const progressRatio = Math.max(0, Math.min(1, rawProgress || (durationSeconds > 0 ? watchSeconds / durationSeconds : 0)));
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

    ensureSupabase();

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('views_count').eq('video_id', videoId).single();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    if (!uid && !sessionId && !fingerprint) {
      return res.json({
        success: true,
        viewsCount: Math.max(0, Number(video.views_count) || 0),
        newView: false,
      });
    }

    const { data: result, error } = await supabase.rpc('record_video_view', {
      p_video_id: videoId,
      p_user_id: uid,
      p_session_id: uid ? null : String(sessionId || '').slice(0, 128),
      p_fingerprint: fingerprint,
      p_ip_hash: hashValue(getClientIp(req)),
      p_watch_seconds: Math.floor(watchSeconds),
      p_progress_ratio: progressRatio,
      p_cooldown_days: Number(process.env.VIDEO_VIEW_COOLDOWN_DAYS || 14),
    });
    if (error) throw error;

    if (result?.counted === true) {
      const updatedViews = Number(result.views || 0);

      // 1000-view milestone: credit $0.65 to the video's creator
      if (updatedViews === 1000) {
        const { data: vidRow } = await supabase
          .from(VIDEOS_TABLE)
          .select('user_id')
          .eq('video_id', videoId)
          .maybeSingle();
        if (vidRow?.user_id) {
          creditViewMilestone(vidRow.user_id, videoId).catch(() => {});
        }
      }

      return res.json({ success: true, viewsCount: updatedViews, newView: true });
    }

    return res.json({
      success: true,
      viewsCount: Math.max(0, Number(result?.views ?? video.views_count) || 0),
      newView: false,
      duplicate: result?.duplicate === true,
      qualified: result?.qualified !== false,
    });
  } catch (err) {
    console.error('tiktokVideo.recordView error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Get comments for a video, descending by created_at.
 */
export async function getComments(req, res) {
  try {
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res, { data: [] });

    ensureSupabase();

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('video_id').eq('video_id', videoId).single();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const { data, error } = await supabase
      .from(COMMENTS_TABLE)
      .select('*')
      .eq('video_id', videoId)
      .is('deleted_at', null)
      .eq('status', 'visible')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    const comments = data || [];
    const userIds = [...new Set(comments.map(c => c.user_id).filter(Boolean))];
    let usernameMap = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase.from('users').select('id, username').in('id', userIds);
      if (users) users.forEach(u => { usernameMap[u.id] = u.username; });
    }
    const enriched = comments.map(c => ({ ...c, username: usernameMap[c.user_id] || null }));

    return res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('tiktokVideo.getComments error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed', data: [] });
  }
}

/**
 * Add comment; increment comments_count.
 */
export async function addComment(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { videoId } = req.params;
    const text = cleanCommentText(req.body?.comment || req.body?.text || '');
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    if (!text) return res.status(400).json({ success: false, message: 'Comment text is required' });
    if (text.length > 1000) return res.status(400).json({ success: false, message: 'Comment is too long' });

    ensureSupabase();

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('comments_count, allow_people_to_comment').eq('video_id', videoId).single();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.allow_people_to_comment === false) {
      return res.status(403).json({ success: false, message: 'Comments are disabled for this video' });
    }

    const { data: commenter } = await supabase.from('users').select('username, display_name').eq('id', uid).maybeSingle();
    const authorName = String(req.body?.authorName || commenter?.display_name || commenter?.username || '').trim().slice(0, 64) || 'Member';
    const { data: result, error } = await supabase.rpc('add_video_comment', {
      p_video_id: videoId,
      p_user_id: uid,
      p_comment: text,
      p_author_name: authorName,
      p_parent_comment_id: req.body?.parentCommentId || req.body?.parent_comment_id || null,
    });
    if (error) throw error;
    const commentRow = result?.comment || {};

    return res.status(201).json({
      success: true,
      comment: {
        id: commentRow.commentId,
        video_id: videoId,
        user_id: uid,
        username: commenter?.username || authorName,
        comment: commentRow.text || text,
        created_at: commentRow.createdAt ? new Date(Number(commentRow.createdAt)).toISOString() : new Date().toISOString(),
        parent_comment_id: commentRow.parentCommentId || null,
      },
      commentsCount: Number(result?.total_comments || 0),
      duplicate: result?.duplicate === true,
    });
  } catch (err) {
    console.error('tiktokVideo.addComment error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Delete comment; only owner. Decrement comments_count.
 */
export async function deleteComment(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const { commentId } = req.params;
    if (!isValidPlatformVideoId(commentId)) {
      return res.status(400).json({ success: false, message: 'Invalid comment ID' });
    }

    ensureSupabase();

    const { data: comment, error: fetchError } = await supabase
      .from(COMMENTS_TABLE)
      .select('id, video_id, user_id')
      .eq('id', commentId)
      .single();

    if (fetchError || !comment) return res.status(404).json({ success: false, message: 'Comment not found' });
    if (comment.user_id !== uid) return res.status(403).json({ success: false, message: 'Only the comment owner can delete it' });

    const { data: result, error } = await supabase.rpc('delete_video_comment', {
      p_video_id: comment.video_id,
      p_comment_id: commentId,
      p_user_id: uid,
    });
    if (error) throw error;
    if (!result?.success) return res.status(404).json({ success: false, message: 'Comment not found' });

    return res.json({ success: true, message: 'Comment deleted', commentsCount: Number(result?.total_comments || 0) });
  } catch (err) {
    console.error('tiktokVideo.deleteComment error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Get playback state for first-time ad logic.
 * Returns: { video, shouldPlayAd, adUrl?, skipAfterSeconds?, hasSeenAd }.
 * Creates play_history row if not exists (has_seen_ad = false). For anonymous, pass session_id in body/query.
 */
export async function getPlaybackState(req, res) {
  try {
    const uid = req.uid || null;
    const sessionId = (req.body?.session_id || req.query?.session_id || '').trim() || null;
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);

    ensureSupabase();

    const { data: video, error: videoError } = await supabase
      .from(VIDEOS_TABLE)
      .select('*')
      .eq('video_id', videoId)
      .single();

    if (videoError || !video) return res.status(404).json({ success: false, message: 'Video not found' });

    if (!uid && !sessionId) {
      return res.json({
        success: true,
        video,
        shouldPlayAd: false,
        hasSeenAd: true,
        adUrl: null,
        skipAfterSeconds: 0,
      });
    }

    let historyRow = null;
    if (uid) {
      const { data } = await supabase
        .from(PLAY_HISTORY_TABLE)
        .select('has_seen_ad')
        .eq('video_id', videoId)
        .eq('user_id', uid)
        .maybeSingle();
      historyRow = data;
    } else {
      const { data } = await supabase
        .from(PLAY_HISTORY_TABLE)
        .select('has_seen_ad')
        .eq('video_id', videoId)
        .eq('session_id', sessionId)
        .maybeSingle();
      historyRow = data;
    }

    const hasSeenAd = historyRow ? historyRow.has_seen_ad === true : false;

    if (!historyRow) {
      if (uid) {
        await supabase.from(PLAY_HISTORY_TABLE).insert({ video_id: videoId, user_id: uid, has_seen_ad: false }).then((r) => {
          if (r.error && r.error.code !== '23505') console.warn('play_history insert', r.error?.message);
        });
      } else {
        await supabase.from(PLAY_HISTORY_TABLE).insert({ video_id: videoId, session_id: sessionId, has_seen_ad: false }).then((r) => {
          if (r.error && r.error.code !== '23505') console.warn('play_history insert session', r.error?.message);
        });
      }
    }

    const shouldPlayAd = !hasSeenAd;

    let adUrl = null;
    let skipAfterSeconds = 5;
    if (shouldPlayAd) {
      const { data: ads } = await supabase.from(ADS_TABLE).select('id, storage_url, skip_after_seconds').eq('is_active', true).limit(10);
      const list = ads || [];
      if (list.length > 0) {
        const ad = list[Math.floor(Math.random() * list.length)];
        adUrl = ad.storage_url;
        skipAfterSeconds = Math.max(0, Number(ad.skip_after_seconds) ?? 5);
      }
    }

    return res.json({
      success: true,
      video,
      shouldPlayAd,
      hasSeenAd,
      adUrl: adUrl || null,
      skipAfterSeconds,
    });
  } catch (err) {
    console.error('tiktokVideo.getPlaybackState error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * Mark ad as completed for this user/session and video. Call after ad finishes or is skipped.
 */
export async function markAdCompleted(req, res) {
  try {
    const uid = req.uid || null;
    const sessionId = (req.body?.session_id || req.query?.session_id || '').trim() || null;
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    if (!uid && !sessionId) {
      return res.json({ success: true, message: 'ok' });
    }

    ensureSupabase();

    if (uid) {
      const { error } = await supabase
        .from(PLAY_HISTORY_TABLE)
        .update({ has_seen_ad: true })
        .eq('video_id', videoId)
        .eq('user_id', uid);
      if (error) {
        const { error: insertErr } = await supabase.from(PLAY_HISTORY_TABLE).insert({ video_id: videoId, user_id: uid, has_seen_ad: true });
        if (insertErr && insertErr.code !== '23505') throw insertErr;
      }
    } else {
      const { error } = await supabase
        .from(PLAY_HISTORY_TABLE)
        .update({ has_seen_ad: true })
        .eq('video_id', videoId)
        .eq('session_id', sessionId);
      if (error) {
        const { error: insertErr } = await supabase.from(PLAY_HISTORY_TABLE).insert({ video_id: videoId, session_id: sessionId, has_seen_ad: true });
        if (insertErr && insertErr.code !== '23505') throw insertErr;
      }
    }

    return res.json({ success: true, message: 'Ad marked as seen' });
  } catch (err) {
    console.error('tiktokVideo.markAdCompleted error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

/**
 * List active ads for rotation (url, skip_after_seconds). Used by backend to pick an ad in getPlaybackState.
 */
export async function getAds(req, res) {
  try {
    ensureSupabase();
    const { data, error } = await supabase.from(ADS_TABLE).select('id, storage_url, title, skip_after_seconds').eq('is_active', true);
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('tiktokVideo.getAds error', err?.message || err);
    return res.status(500).json({ success: false, data: [] });
  }
}

/**
 * Record ad impression (optional analytics). Body: { ad_id, skipped }.
 */
export async function recordAdImpression(req, res) {
  try {
    const uid = req.uid || null;
    const sessionId = (req.body?.session_id || req.query?.session_id || '').trim() || null;
    const { videoId } = req.params;
    const adId = req.body?.ad_id;
    const skipped = req.body?.skipped === true;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    if (!adId) return res.status(400).json({ success: false, message: 'ad_id required' });

    ensureSupabase();

    await supabase.from(AD_IMPRESSIONS_TABLE).insert({
      ad_id: adId,
      video_id: videoId,
      user_id: uid || null,
      session_id: sessionId || null,
      skipped,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('tiktokVideo.recordAdImpression error', err?.message || err);
    return res.status(500).json({ success: false });
  }
}
