/**
 * TikTok-style video system: Supabase Storage + Postgres (tiktok_videos, video_likes, views, comments).
 * Firebase Auth only for user_id; all writes go through this backend with requireAuth where needed.
 */
import crypto from 'crypto';
import { supabase, uploadFileToBucket, getPublicUrl, VIDEO_BUCKET, isConfigured as isSupabaseConfigured } from '../config/supabase.js';
import { ensureVideoFilenameForStorage, resolveVideoContentType } from '../utils/videoStorage.js';

const VIDEOS_TABLE = 'tiktok_videos';
const LIKES_TABLE = 'tiktok_video_likes';
const VIEWS_TABLE = 'tiktok_video_views';
const COMMENTS_TABLE = 'tiktok_video_comments';
const PLAY_HISTORY_TABLE = 'video_play_history';
const ADS_TABLE = 'video_ads';
const AD_IMPRESSIONS_TABLE = 'video_ad_impressions';

function ensureSupabase() {
  if (!isSupabaseConfigured() || !supabase) throw new Error('Supabase not configured');
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

    const { error } = await supabase.from(VIDEOS_TABLE).insert({
      video_id: videoId,
      user_id: uid,
      storage_url: storageUrl,
      title,
      description,
      likes_count: 0,
      views_count: 0,
      comments_count: 0,
    });

    if (error) throw error;

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

    return res.json({ success: true, data: data || [], page, limit });
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

    return res.json({ success: true, data: data || [], page, limit });
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
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    ensureSupabase();

    const { data, error } = await supabase
      .from(VIDEOS_TABLE)
      .select('*')
      .eq('video_id', videoId)
      .single();

    if (error || !data) return res.status(404).json({ success: false, message: 'Video not found' });

    return res.json({ success: true, data });
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
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    ensureSupabase();

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('likes_count').eq('video_id', videoId).single();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const { error: likeError } = await supabase.from(LIKES_TABLE).insert({ video_id: videoId, user_id: uid });
    if (likeError) {
      if (likeError.code === '23505') return res.json({ success: true, liked: true, likesCount: video.likes_count });
      throw likeError;
    }

    // BUG-04: Atomic increment via RPC
    const { data: newCount } = await supabase.rpc('adjust_tiktok_stat', {
      p_video_id: videoId,
      p_stat_name: 'likes_count',
      p_delta: 1
    });

    return res.json({ success: true, liked: true, likesCount: newCount || 0 });
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
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    ensureSupabase();

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('likes_count').eq('video_id', videoId).single();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const { data: deleted } = await supabase.from(LIKES_TABLE).delete().eq('video_id', videoId).eq('user_id', uid).select('video_id');
    const didRemove = deleted && deleted.length > 0;

    if (didRemove) {
      // BUG-04: Atomic decrement via RPC
      const { data: newCount } = await supabase.rpc('adjust_tiktok_stat', {
        p_video_id: videoId,
        p_stat_name: 'likes_count',
        p_delta: -1
      });
      return res.json({ success: true, liked: false, likesCount: newCount || 0 });
    }

    return res.json({ success: true, liked: false, likesCount: Math.max(0, video.likes_count || 0) });
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
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    if (!uid) return res.json({ success: true, liked: false });

    ensureSupabase();

    const { data } = await supabase.from(LIKES_TABLE).select('video_id').eq('video_id', videoId).eq('user_id', uid).maybeSingle();
    return res.json({ success: true, liked: !!data });
  } catch (err) {
    return res.json({ success: true, liked: false });
  }
}

/**
 * Record view: one per user or session. Increment views_count only on new view.
 */
export async function recordView(req, res) {
  try {
    const uid = req.uid || null;
    const sessionId = (req.body?.session_id || req.query?.session_id || '').trim() || null;
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId or session_id required for anonymous' });

    if (!uid && !sessionId) return res.status(400).json({ success: false, message: 'Authentication or session_id required' });

    ensureSupabase();

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('views_count').eq('video_id', videoId).single();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    let inserted = false;
    if (uid) {
      const { error } = await supabase.from(VIEWS_TABLE).insert({ video_id: videoId, user_id: uid });
      inserted = !error;
      if (error && error.code !== '23505') throw error;
    } else {
      const { error } = await supabase.from(VIEWS_TABLE).insert({ video_id: videoId, session_id: sessionId });
      inserted = !error;
      if (error && error.code !== '23505') throw error;
    }

    if (inserted) {
      // BUG-04: Atomic increment via RPC
      const { data: newCount } = await supabase.rpc('adjust_tiktok_stat', {
        p_video_id: videoId,
        p_stat_name: 'views_count',
        p_delta: 1
      });
      return res.json({ success: true, viewsCount: newCount || 0, newView: true });
    }

    return res.json({ success: true, viewsCount: Math.max(0, video.views_count || 0), newView: false });
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
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    ensureSupabase();

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('video_id').eq('video_id', videoId).single();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const { data, error } = await supabase
      .from(COMMENTS_TABLE)
      .select('*')
      .eq('video_id', videoId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json({ success: true, data: data || [] });
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
    const text = (req.body?.comment || req.body?.text || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    if (!text) return res.status(400).json({ success: false, message: 'Comment text is required' });

    ensureSupabase();

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('comments_count').eq('video_id', videoId).single();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const { data: commentRow, error: insertError } = await supabase
      .from(COMMENTS_TABLE)
      .insert({ video_id: videoId, user_id: uid, comment: text })
      .select()
      .single();

    if (insertError) throw insertError;

    // BUG-04: Atomic increment via RPC
    const { data: newCount } = await supabase.rpc('adjust_tiktok_stat', {
      p_video_id: videoId,
      p_stat_name: 'comments_count',
      p_delta: 1
    });

    return res.status(201).json({
      success: true,
      comment: {
        id: commentRow.id,
        video_id: commentRow.video_id,
        user_id: commentRow.user_id,
        comment: commentRow.comment,
        created_at: commentRow.created_at,
      },
      commentsCount: newCount || 0,
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
    if (!commentId) return res.status(400).json({ success: false, message: 'commentId required' });

    ensureSupabase();

    const { data: comment, error: fetchError } = await supabase
      .from(COMMENTS_TABLE)
      .select('id, video_id, user_id')
      .eq('id', commentId)
      .single();

    if (fetchError || !comment) return res.status(404).json({ success: false, message: 'Comment not found' });
    if (comment.user_id !== uid) return res.status(403).json({ success: false, message: 'Only the comment owner can delete it' });

    const { error: deleteError } = await supabase.from(COMMENTS_TABLE).delete().eq('id', commentId);
    if (deleteError) throw deleteError;

    const { data: video } = await supabase.from(VIDEOS_TABLE).select('comments_count').eq('video_id', comment.video_id).single();
    if (video) {
      // BUG-04: Atomic decrement via RPC
      await supabase.rpc('adjust_tiktok_stat', {
        p_video_id: comment.video_id,
        p_stat_name: 'comments_count',
        p_delta: -1
      });
    }

    return res.json({ success: true, message: 'Comment deleted' });
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
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    if (!uid && !sessionId) return res.status(400).json({ success: false, message: 'user or session_id required for playback state' });

    ensureSupabase();

    const { data: video, error: videoError } = await supabase
      .from(VIDEOS_TABLE)
      .select('*')
      .eq('video_id', videoId)
      .single();

    if (videoError || !video) return res.status(404).json({ success: false, message: 'Video not found' });

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
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    if (!uid && !sessionId) return res.status(400).json({ success: false, message: 'user or session_id required' });

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
    if (!videoId || !adId) return res.status(400).json({ success: false, message: 'videoId and ad_id required' });

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
