import { supabase } from '../config/supabase.js';
import { getRelatedVideos } from '../services/searchIndex.service.js';

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' || /schema cache/i.test(String(err?.message || ''));
}

export async function updateWatchProgress(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const videoId = String(req.params.id || req.params.videoId || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });

    const progressSeconds = Math.max(0, Number(req.body?.progressSeconds ?? req.body?.progress_seconds ?? 0));
    const durationSeconds = Math.max(0, Number(req.body?.durationSeconds ?? req.body?.duration_seconds ?? 0));
    const completed = req.body?.completed === true || (durationSeconds > 0 && progressSeconds >= durationSeconds * 0.9);

    if (!supabase) {
      return res.json({ success: true, stored: false });
    }

    const { error } = await supabase.from('video_watch_history').upsert({
      user_id: uid,
      video_id: videoId,
      progress_seconds: progressSeconds,
      duration_seconds: durationSeconds,
      completed,
      last_watched_at: new Date().toISOString(),
    }, { onConflict: 'user_id,video_id' });

    if (error && !isMissingTable(error)) throw error;
    return res.json({ success: true, progressSeconds, completed });
  } catch (err) {
    console.error('[watchHistory] update error:', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function getContinueWatching(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!supabase) return res.json({ success: true, data: [] });

    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const { data: history, error } = await supabase
      .from('video_watch_history')
      .select('*')
      .eq('user_id', uid)
      .eq('completed', false)
      .order('last_watched_at', { ascending: false })
      .limit(limit);

    if (error) {
      if (isMissingTable(error)) return res.json({ success: true, data: [] });
      throw error;
    }

    const ids = (history || []).map((h) => h.video_id).filter(Boolean);
    if (!ids.length) return res.json({ success: true, data: [] });

    const { data: videos } = await supabase.from('tiktok_videos').select('*').in('video_id', ids);
    const byId = new Map((videos || []).map((v) => [String(v.video_id), v]));

    const data = (history || []).map((h) => {
      const v = byId.get(String(h.video_id));
      if (!v) return null;
      return {
        videoId: v.video_id,
        title: v.title,
        thumbnailUrl: v.thumbnail_url,
        progressSeconds: Number(h.progress_seconds || 0),
        durationSeconds: Number(h.duration_seconds || v.duration_seconds || v.duration || 0),
        lastWatchedAt: h.last_watched_at,
      };
    }).filter(Boolean);

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, data: [], message: err?.message || 'Failed' });
  }
}

export async function getRelatedVideosHandler(req, res) {
  try {
    const videoId = String(req.params.id || req.params.videoId || '').trim();
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 6));
    const data = await getRelatedVideos(videoId, limit);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, data: [], message: err?.message || 'Failed' });
  }
}
