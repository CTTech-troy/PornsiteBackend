/**
 * Video interactions (like/unlike/comment/view) — Supabase primary.
 * All data written to tiktok_videos, tiktok_video_likes, tiktok_video_comments,
 * tiktok_video_views via atomic RPCs.
 */
import { supabase } from '../config/supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

export async function getLikeStatus(req, res) {
  try {
    const uid = req.uid;
    const { videoId } = req.params;
    if (!isValidUuid(videoId)) return res.json({ liked: false, totalLikes: 0, totalComments: 0 });
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
    if (!isValidUuid(videoId))  return res.status(400).json({ error: 'videoId required' });
    if (!supabase)              return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });

    const { data: result, error } = await supabase.rpc('like_video', {
      p_video_id: videoId,
      p_user_id:  uid,
    });
    if (error) throw error;
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
    if (!isValidUuid(videoId))  return res.status(400).json({ error: 'videoId required' });
    if (!supabase)              return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });

    const { data: result, error } = await supabase.rpc('unlike_video', {
      p_video_id: videoId,
      p_user_id:  uid,
    });
    if (error) throw error;
    return res.json({ liked: false, totalLikes: result?.total_likes ?? 0 });
  } catch (err) {
    console.error('videoInteractions.unlikeVideo', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

export async function getComments(req, res) {
  try {
    const { videoId } = req.params;
    if (!isValidUuid(videoId)) return res.status(400).json({ error: 'videoId required' });
    if (!supabase)             return res.json({ data: [] });

    const { data, error } = await supabase
      .from('tiktok_video_comments')
      .select('id, user_id, author_name, comment, created_at')
      .eq('video_id', videoId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    const list = (data || []).map((c) => ({
      commentId:   c.id,
      userId:      c.user_id,
      authorName:  c.author_name || 'Member',
      text:        c.comment,
      createdAt:   new Date(c.created_at).getTime(),
    }));
    return res.json({ data: list });
  } catch (err) {
    console.error('videoInteractions.getComments', err?.message || err);
    return res.status(500).json({ data: [] });
  }
}

export async function addComment(req, res) {
  try {
    const uid = req.uid;
    if (!uid)                   return res.status(401).json({ error: 'Authentication required' });
    const { videoId } = req.params;
    const text = (req.body?.text || '').trim();
    if (!isValidUuid(videoId))  return res.status(400).json({ error: 'videoId required' });
    if (!text)                  return res.status(400).json({ error: 'Comment text is required' });
    if (!supabase)              return res.status(503).json({ error: 'Video interactions temporarily unavailable.' });

    const authorName = String(req.body?.authorName || '').trim().slice(0, 64) || 'Member';

    const { data: inserted, error: insErr } = await supabase
      .from('tiktok_video_comments')
      .insert([{ video_id: videoId, user_id: uid, author_name: authorName, comment: text }])
      .select('id, created_at')
      .single();
    if (insErr) throw insErr;

    const { data: video } = await supabase
      .from('tiktok_videos')
      .select('comments_count')
      .eq('video_id', videoId)
      .maybeSingle();
    const newTotal = Number(video?.comments_count || 0) + 1;
    await supabase
      .from('tiktok_videos')
      .update({ comments_count: newTotal })
      .eq('video_id', videoId);

    return res.status(201).json({
      comment: {
        commentId:  inserted.id,
        userId:     uid,
        authorName,
        text,
        createdAt:  new Date(inserted.created_at).getTime(),
      },
      totalComments: newTotal,
    });
  } catch (err) {
    console.error('videoInteractions.addComment', err?.message || err);
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
    if (!isValidUuid(videoId)) return res.status(400).json({ error: 'videoId required' });
    if (!supabase)             return res.json({ success: true, views: 0 });

    const sessionId = String(req.body?.sessionId || '').trim();
    const uid       = req.uid || null;
    const rawKey    = uid || sessionId;
    if (!rawKey) return res.status(400).json({ error: 'sessionId required' });

    const { data: result, error } = await supabase.rpc('record_video_view', {
      p_video_id:   videoId,
      p_user_id:    uid,
      p_session_id: uid ? null : sessionId.slice(0, 128),
    });
    if (error) throw error;

    return res.json({
      success:   result?.success ?? true,
      views:     result?.views   ?? 0,
      duplicate: result?.duplicate ?? false,
    });
  } catch (err) {
    console.error('videoInteractions.recordPublicVideoView', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}
