/**
 * Video interactions (like/unlike/comment/view) — Supabase primary.
 * All data written to tiktok_videos, tiktok_video_likes, tiktok_video_comments,
 * tiktok_video_views via atomic RPCs.
 */
import crypto from 'crypto';
import { supabase } from '../config/supabase.js';
import { invalidVideoIdResponse, isValidPlatformVideoId } from '../utils/videoIdValidation.js';
import {
  deleteVideoComment,
  fetchVideoComments,
  insertVideoComment,
  updateVideoComment,
} from '../utils/videoCommentsQuery.js';
import { enqueueSearchIndex } from '../services/searchIndex.service.js';
import { invalidateTopCreatorsCache } from '../services/creatorLeaderboard.service.js';
import { recordAnalyticsEngagement } from '../services/analytics.service.js';
import { emitPlatformActivity } from '../services/platformActivity.service.js';

function invalidateCreatorLeaderboard() {
  try {
    invalidateTopCreatorsCache();
  } catch (_) {}
}

function cleanText(value, max = 1000) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}

function hashValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const salt = process.env.ENGAGEMENT_HASH_SALT || process.env.JWT_SECRET || 'xstream-engagement';
  return crypto.createHash('sha256').update(`${salt}:${raw}`).digest('hex');
}

function isPubliclyListedRow(row = {}) {
  if (!row) return false;
  if (row.deleted_at) return false;
  const status = String(row.status || '').toLowerCase();
  const visibility = String(row.visibility || 'public').toLowerCase();
  if (visibility && visibility !== 'public') return false;
  if (status && !['published', 'live', 'public'].includes(status)) return false;
  if (row.is_live === false && !status) return false;
  return true;
}

async function getVideoForInteraction(videoId, select = 'video_id, is_live, status, visibility, deleted_at, allow_people_to_comment') {
  const { data, error } = await supabase
    .from('tiktok_videos')
    .select(select)
    .eq('video_id', videoId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function safeCount(value) {
  return Math.max(0, Number(value) || 0);
}

export async function getLikeStatus(req, res) {
  try {
    const uid = req.uid;
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res, { liked: false, totalLikes: 0, totalComments: 0 });
    if (!supabase)              return res.json({ liked: false, totalLikes: 0, totalComments: 0 });

    const { data: video } = await supabase
      .from('tiktok_videos')
      .select('likes_count, comments_count')
      .eq('video_id', videoId)
      .maybeSingle();

    const totalLikes    = Number(video?.likes_count    || 0);
    const totalComments = Number(video?.comments_count || 0);

    if (!uid) return res.json({ liked: false, totalLikes, totalComments });

    const { data: like } = await supabase
      .from('tiktok_video_likes')
      .select('user_id')
      .eq('video_id', videoId)
      .eq('user_id', uid)
      .maybeSingle();

    return res.json({ liked: !!like, totalLikes, totalComments });
  } catch (err) {
    console.error('videoInteractions.getLikeStatus', err?.message || err);
    return res.json({ liked: false, totalLikes: 0, totalComments: 0 });
  }
}

export async function likeVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid)                   return res.status(401).json({ error: 'Authentication required' });
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    if (!supabase)              return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });

    const video = await getVideoForInteraction(videoId, 'video_id, is_live, status, visibility, deleted_at');
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!isPubliclyListedRow(video)) return res.status(400).json({ error: 'Video is not available for likes' });

    const { data: result, error } = await supabase.rpc('like_video', {
      p_video_id: videoId,
      p_user_id:  uid,
    });
    if (error) throw error;
    enqueueSearchIndex(videoId, 'upsert').catch(() => {});
    invalidateCreatorLeaderboard();
    if (result?.duplicate !== true && result?.counted !== false) {
      recordAnalyticsEngagement({
        eventType: 'like',
        videoId,
        userId: uid,
        sessionId: req.body?.sessionId || req.body?.session_id || null,
      }).catch(() => {});
      emitPlatformActivity(req.app?.get?.('io'), 'like', {
        actorId: uid,
        targetType: 'video',
        targetId: videoId,
        payload: { videoId, totalLikes: result?.total_likes ?? 0 },
      });
    }
    return res.json({ liked: true, totalLikes: result?.total_likes ?? 0 });
  } catch (err) {
    console.error('videoInteractions.likeVideo', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

export async function unlikeVideo(req, res) {
  try {
    const uid = req.uid;
    if (!uid)                   return res.status(401).json({ error: 'Authentication required' });
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    if (!supabase)              return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });

    const video = await getVideoForInteraction(videoId, 'video_id');
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const { data: result, error } = await supabase.rpc('unlike_video', {
      p_video_id: videoId,
      p_user_id:  uid,
    });
    if (error) throw error;
    enqueueSearchIndex(videoId, 'upsert').catch(() => {});
    invalidateCreatorLeaderboard();
    return res.json({ liked: false, totalLikes: result?.total_likes ?? 0 });
  } catch (err) {
    console.error('videoInteractions.unlikeVideo', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

export async function getComments(req, res) {
  try {
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res, { data: [] });
    if (!supabase)             return res.json({ data: [] });

    const video = await getVideoForInteraction(videoId, 'video_id, is_live, status, visibility, deleted_at');
    if (!video) return res.status(404).json({ success: false, message: 'Video not found', data: [] });
    if (!isPubliclyListedRow(video)) return res.status(404).json({ success: false, message: 'Video not available', data: [] });

    const list = await fetchVideoComments(videoId);
    return res.json({ data: list });
  } catch (err) {
    console.error('videoInteractions.getComments', err?.message || err);
    return res.json({ data: [] });
  }
}

export async function addComment(req, res) {
  try {
    const uid = req.uid;
    if (!uid)                   return res.status(401).json({ error: 'Authentication required' });
    const { videoId } = req.params;
    const text = cleanText(req.body?.text || req.body?.comment || '');
    const parentCommentId = String(req.body?.parentCommentId || req.body?.parent_comment_id || '').trim() || null;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    if (!text)                  return res.status(400).json({ error: 'Comment text is required' });
    if (text.length > 1000)     return res.status(400).json({ error: 'Comment is too long' });
    if (parentCommentId && !isValidPlatformVideoId(parentCommentId)) {
      return res.status(400).json({ error: 'Invalid parent comment ID' });
    }
    if (!supabase)              return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });

    const authorName = String(req.body?.authorName || '').trim().slice(0, 64) || 'Member';

    const video = await getVideoForInteraction(videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!isPubliclyListedRow(video)) return res.status(400).json({ error: 'Video is not available for comments' });
    if (video.allow_people_to_comment === false) return res.status(403).json({ error: 'Comments are disabled for this video' });

    const inserted = await insertVideoComment({ videoId, userId: uid, text, authorName, parentCommentId });

    let newTotal = safeCount(inserted.total_comments);
    if (!inserted.rpc) {
      const { data: countRow } = await supabase
        .from('tiktok_videos')
        .select('comments_count')
        .eq('video_id', videoId)
        .maybeSingle();
      newTotal = safeCount(countRow?.comments_count) + 1;
      await supabase
        .from('tiktok_videos')
        .update({ comments_count: newTotal })
        .eq('video_id', videoId);
    }

    if (!inserted.duplicate) {
      enqueueSearchIndex(videoId, 'upsert').catch(() => {});
      invalidateCreatorLeaderboard();
      recordAnalyticsEngagement({
        eventType: 'comment',
        videoId,
        userId: uid,
        sessionId: req.body?.sessionId || req.body?.session_id || null,
        metadata: { parentCommentId },
      }).catch(() => {});
      emitPlatformActivity(req.app?.get?.('io'), 'comment', {
        actorId: uid,
        targetType: 'video',
        targetId: videoId,
        payload: { videoId, commentId: inserted.id, parentCommentId, totalComments: newTotal },
      });
    }

    return res.status(201).json({
      success: true,
      comment: {
        commentId:  inserted.id,
        userId:     uid,
        authorName,
        text:        inserted.text || text,
        createdAt:  new Date(inserted.created_at).getTime(),
        parentCommentId: inserted.parent_comment_id || parentCommentId || null,
      },
      totalComments: newTotal,
      duplicate: inserted.duplicate === true,
    });
  } catch (err) {
    console.error('videoInteractions.addComment', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

export async function editComment(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ error: 'Authentication required' });
    const { videoId, commentId } = req.params;
    const text = cleanText(req.body?.text || req.body?.comment || '');
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    if (!isValidPlatformVideoId(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });
    if (!text) return res.status(400).json({ error: 'Comment text is required' });
    if (!supabase) return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });

    const result = await updateVideoComment({ videoId, commentId, userId: uid, text });
    if (!result?.success) return res.status(404).json({ error: 'Comment not found' });
    enqueueSearchIndex(videoId, 'upsert').catch(() => {});
    return res.json({ success: true, comment: result.comment });
  } catch (err) {
    console.error('videoInteractions.editComment', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

export async function removeComment(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ error: 'Authentication required' });
    const { videoId, commentId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    if (!isValidPlatformVideoId(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });
    if (!supabase) return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });

    const result = await deleteVideoComment({ videoId, commentId, userId: uid });
    if (!result?.success) return res.status(404).json({ error: 'Comment not found' });
    enqueueSearchIndex(videoId, 'upsert').catch(() => {});
    invalidateCreatorLeaderboard();
    return res.json({ success: true, totalComments: safeCount(result.total_comments) });
  } catch (err) {
    console.error('videoInteractions.removeComment', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

/**
 * POST /api/videos/public/:videoId/view
 * Records a view with dedup. Requires sessionId in body; uid preferred if authenticated.
 */
export async function recordPublicVideoView(req, res) {
  try {
    const { videoId } = req.params;
    if (!isValidPlatformVideoId(videoId)) return invalidVideoIdResponse(res);
    if (!supabase)             return res.json({ success: true, views: 0 });

    const sessionId = String(req.body?.sessionId || req.body?.session_id || '').trim();
    const fingerprint = String(req.body?.fingerprint || '').trim().slice(0, 160);
    const watchSeconds = Math.max(0, Math.min(86400, Number(req.body?.watchSeconds ?? req.body?.watch_seconds ?? 0) || 0));
    const durationSeconds = Math.max(0, Number(req.body?.durationSeconds ?? req.body?.duration_seconds ?? 0) || 0);
    const rawProgress = Number(req.body?.progressRatio ?? req.body?.progress_ratio ?? 0) || 0;
    const progressRatio = Math.max(0, Math.min(1, rawProgress || (durationSeconds > 0 ? watchSeconds / durationSeconds : 0)));
    const uid       = req.uid || null;
    const ipHash    = hashValue(getClientIp(req));
    const rawKey    = uid || fingerprint || sessionId || ipHash;
    if (!rawKey) return res.status(400).json({ error: 'sessionId required' });
    if (watchSeconds < 10 && progressRatio < 0.2) {
      const { data: video } = await supabase
        .from('tiktok_videos')
        .select('views_count')
        .eq('video_id', videoId)
        .maybeSingle();
      return res.json({
        success: true,
        views: safeCount(video?.views_count),
        duplicate: true,
        counted: false,
        qualified: false,
      });
    }

    const { data: result, error } = await supabase.rpc('record_video_view', {
      p_video_id:   videoId,
      p_user_id:    uid,
      p_session_id: uid ? null : sessionId.slice(0, 128),
      p_fingerprint: fingerprint || null,
      p_ip_hash: ipHash,
      p_watch_seconds: Math.floor(watchSeconds),
      p_progress_ratio: progressRatio,
      p_cooldown_days: Number(process.env.VIDEO_VIEW_COOLDOWN_DAYS || 14),
    });
    if (error) throw error;
    if (result?.counted === true || result?.duplicate !== true) {
      enqueueSearchIndex(videoId, 'upsert').catch(() => {});
      invalidateCreatorLeaderboard();
      emitPlatformActivity(req.app?.get?.('io'), 'video_view', {
        actorId: uid,
        targetType: 'video',
        targetId: videoId,
        payload: {
          videoId,
          sessionId: uid ? null : sessionId.slice(0, 128),
          views: result?.views ?? 0,
          counted: result?.counted ?? false,
          watchSeconds: Math.floor(watchSeconds),
          progressRatio,
        },
      });
    }

    return res.json({
      success:   result?.success ?? true,
      views:     result?.views   ?? 0,
      duplicate: result?.duplicate ?? false,
      counted:   result?.counted ?? false,
      qualified: result?.qualified ?? true,
    });
  } catch (err) {
    console.error('videoInteractions.recordPublicVideoView', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}
