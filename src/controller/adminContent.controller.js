import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';

function paginate(page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
}

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'));
}

function isMissingColumn(err) {
  return err?.code === '42703';
}

async function logAction(adminId, adminName, action, targetType, targetId, details = {}) {
  await supabase.from('admin_audit_logs').insert({
    id: randomUUID(),
    admin_id: adminId || null,
    admin_name: adminName || 'Admin',
    action,
    target_type: targetType,
    target_id: String(targetId || ''),
    details,
    status: 'success',
  });
}

// Maps a Supabase tiktok_videos row to the standard admin Video shape.
// ID is plain — no prefix.
function mapSupabaseVideo(v, userMap) {
  return {
    id: v.video_id,
    title: v.title || 'Untitled',
    thumbnail: v.thumbnail_url || null,
    creatorName: userMap[v.user_id]?.username || 'Unknown',
    channelName: userMap[v.user_id]?.username || '',
    uploadDate: v.created_at || null,
    status: v.status || 'published',
    visibility: v.visibility || 'public',
    views: Number(v.views_count || 0),
    likes: Number(v.likes_count || 0),
    reports: Number(v.reports_count || 0),
    earnings: Number(v.earnings || 0),
    price: Number(v.coin_price || 0),
    videoUrl: v.storage_url || null,
    duration: v.duration || null,
    description: v.description || '',
    tags: v.tags || [],
    source: 'supabase',
  };
}

// Maps a Firebase RTDB video to the standard admin Video shape.
// ID is prefixed with "rtdb:" so update/delete handlers can route correctly.
function mapRtdbVideo(videoId, v) {
  return {
    id: `rtdb:${videoId}`,
    title: v.title || 'Untitled',
    thumbnail: v.thumbnailUrl || null,
    creatorName: v.creatorDisplayName || 'Unknown',
    channelName: v.creatorDisplayName || '',
    uploadDate: v.createdAt ? new Date(v.createdAt).toISOString() : null,
    status: v.isLive === false ? 'removed' : 'published',
    visibility: 'public',
    views: Number(v.totalViews || 0),
    likes: Number(v.totalLikes || 0),
    reports: 0,
    earnings: 0,
    price: Number(v.tokenPrice || 0),
    videoUrl: v.videoUrl || v.streamUrl || null,
    duration: v.durationSeconds || null,
    description: v.description || '',
    tags: Array.isArray(v.tags) ? v.tags : [],
    source: 'rtdb',
  };
}

// Fetch all videos from Firebase RTDB (isLive only), apply filters, return mapped array.
async function fetchRtdbVideos({ search, statusFilter, isPremium }) {
  try {
    const rtdb = getFirebaseRtdb();
    if (!rtdb) return [];
    const snap = await rtdb.ref('videos').once('value');
    const val = snap.val();
    if (!val) return [];

    let list = Object.entries(val).map(([id, v]) => ({ _id: id, ...v }));

    // statusFilter mapping: 'published' → isLive true, 'removed' → isLive false, others → skip RTDB (no concept)
    if (statusFilter === 'blocked' || statusFilter === 'pending') return []; // RTDB has no blocked/pending
    if (statusFilter === 'published') list = list.filter(v => v.isLive === true);
    if (statusFilter === 'removed') list = list.filter(v => v.isLive === false);

    if (isPremium === 'true') list = list.filter(v => v.isPremiumContent === true);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(v => (v.title || '').toLowerCase().includes(q));
    }

    return list.map(v => mapRtdbVideo(v._id, v));
  } catch {
    return [];
  }
}

// Fetch all matching videos from Supabase tiktok_videos (no pagination — we merge in memory).
async function fetchSupabaseVideos({ search, statusFilter, isPremium }) {
  try {
    let q = supabase.from('tiktok_videos').select('*').order('created_at', { ascending: false });
    if (isPremium === 'true') q = q.gt('coin_price', 0);
    if (statusFilter) q = q.eq('status', statusFilter);
    if (search) q = q.ilike('title', `%${search}%`);

    let { data, error } = await q;
    if (error) {
      if (isMissingTable(error)) return [];
      if (isMissingColumn(error)) {
        let retry = supabase.from('tiktok_videos').select('*').order('created_at', { ascending: false });
        if (search) retry = retry.ilike('title', `%${search}%`);
        ({ data, error } = await retry);
        if (error) return [];
      } else {
        return [];
      }
    }

    const rows = data || [];
    const userIds = [...new Set(rows.map(v => v.user_id).filter(Boolean))];
    let userMap = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase.from('users').select('id, username, avatar').in('id', userIds);
      (users || []).forEach(u => { userMap[u.id] = u; });
    }
    return rows.map(v => mapSupabaseVideo(v, userMap));
  } catch {
    return [];
  }
}

// ── GET /api/admin/content/videos ─────────────────────────────────────────────
// Merges Firebase RTDB (public videos) + Supabase tiktok_videos.
// isPremium=true filters to premium content from both sources.
// RTDB video IDs are prefixed with "rtdb:" so moderation actions route correctly.

export async function getVideos(req, res) {
  try {
    const { search = '', statusFilter = '', isPremium = '', page: rawPage, limit: rawLimit } = req.query;
    const { page, limit, offset } = paginate(rawPage, rawLimit);

    const [rtdbVideos, supabaseVideos] = await Promise.all([
      fetchRtdbVideos({ search, statusFilter, isPremium }),
      fetchSupabaseVideos({ search, statusFilter, isPremium }),
    ]);

    // Merge and sort newest first
    const all = [...rtdbVideos, ...supabaseVideos].sort((a, b) => {
      return new Date(b.uploadDate || 0).getTime() - new Date(a.uploadDate || 0).getTime();
    });

    const total = all.length;
    const videos = all.slice(offset, offset + limit);
    return res.json({ videos, total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/videos/:id ─────────────────────────────────────────

export async function getVideoById(req, res) {
  try {
    const { id } = req.params;
    if (id.startsWith('rtdb:')) {
      const realId = id.slice(5);
      const rtdb = getFirebaseRtdb();
      if (!rtdb) return res.status(503).json({ message: 'Firebase unavailable.' });
      const snap = await rtdb.ref(`videos/${realId}`).once('value');
      const v = snap.val();
      if (!v) return res.status(404).json({ message: 'Video not found.' });
      return res.json({ video: mapRtdbVideo(realId, v) });
    }
    const { data, error } = await supabase.from('tiktok_videos').select('*').eq('video_id', id).maybeSingle();
    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: 'Video not found.' });
    return res.json({ video: mapSupabaseVideo(data, {}) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/content/videos/:id/status ──────────────────────────────────

export async function updateVideoStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, reason = '' } = req.body;
    const allowed = ['published', 'blocked', 'removed', 'pending'];
    if (!allowed.includes(status)) return res.status(400).json({ message: 'Invalid status.' });

    if (id.startsWith('rtdb:')) {
      const realId = id.slice(5);
      const rtdb = getFirebaseRtdb();
      if (!rtdb) return res.status(503).json({ message: 'Firebase unavailable.' });
      await rtdb.ref(`videos/${realId}`).update({ isLive: status === 'published' });
      await logAction(req.admin?.id, req.admin?.name, `Video ${status}`, 'video', id, { reason, status });
      return res.json({ message: `Video ${status} successfully.` });
    }

    const { error } = await supabase.from('tiktok_videos').update({ status }).eq('video_id', id);
    if (error) return res.status(500).json({ message: error.message });
    await logAction(req.admin?.id, req.admin?.name, `Video ${status}`, 'video', id, { reason, status });
    return res.json({ message: `Video ${status} successfully.` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── DELETE /api/admin/content/videos/:id ──────────────────────────────────────

export async function deleteVideo(req, res) {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body;

    if (id.startsWith('rtdb:')) {
      const realId = id.slice(5);
      const rtdb = getFirebaseRtdb();
      if (!rtdb) return res.status(503).json({ message: 'Firebase unavailable.' });
      await rtdb.ref(`videos/${realId}`).remove();
      await logAction(req.admin?.id, req.admin?.name, 'Video deleted', 'video', id, { reason });
      return res.json({ message: 'Video deleted successfully.' });
    }

    const { error } = await supabase.from('tiktok_videos').delete().eq('video_id', id);
    if (error) return res.status(500).json({ message: error.message });
    await logAction(req.admin?.id, req.admin?.name, 'Video deleted', 'video', id, { reason });
    return res.json({ message: 'Video deleted successfully.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/lives ──────────────────────────────────────────────

export async function getLiveSessions(req, res) {
  try {
    const { search = '', statusFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    let countQ = supabase.from('lives').select('*', { count: 'exact', head: true });
    if (statusFilter) countQ = countQ.eq('status', statusFilter);
    if (search) countQ = countQ.or(`host_id.ilike.%${search}%`);

    const { count, error: countErr } = await countQ;
    if (countErr) {
      if (isMissingTable(countErr)) return res.json({ lives: [], total: 0, page, limit });
      return res.status(500).json({ message: countErr.message });
    }

    const total = count || 0;
    if (total === 0 || offset >= total) return res.json({ lives: [], total, page, limit });

    let q = supabase.from('lives').select(
      'id, host_id, status, viewers_count, total_likes, total_gifts_amount, created_at, ended_at'
    );
    if (statusFilter) q = q.eq('status', statusFilter);
    if (search) q = q.or(`host_id.ilike.%${search}%`);
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });

    // Enrich with host display names
    const lives = data || [];
    const hostIds = [...new Set(lives.map(l => l.host_id).filter(Boolean))];
    let userMap = {};
    if (hostIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, username, avatar')
        .in('id', hostIds);
      (users || []).forEach(u => { userMap[u.id] = u; });
    }

    const enriched = lives.map(l => ({
      ...l,
      hostName: userMap[l.host_id]?.username || 'Unknown',
      hostAvatar: userMap[l.host_id]?.avatar || null,
    }));

    return res.json({ lives: enriched, total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/lives/:id ─────────────────────────────────────────

export async function getLiveSessionById(req, res) {
  try {
    const { id } = req.params;

    const { data: live, error } = await supabase
      .from('lives')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!live) return res.status(404).json({ message: 'Live session not found.' });

    // Enrich host info
    let host = null;
    if (live.host_id) {
      const { data: u } = await supabase.from('users').select('id, username, avatar').eq('id', live.host_id).maybeSingle();
      host = u;
    }

    // Fetch gifts for this live
    const { data: gifts } = await supabase
      .from('live_gifts')
      .select('*')
      .eq('live_id', id)
      .order('created_at', { ascending: false })
      .limit(100);

    // Fetch viewers
    const { data: viewers } = await supabase
      .from('live_viewers')
      .select('*')
      .eq('live_id', id)
      .order('joined_at', { ascending: false })
      .limit(100);

    return res.json({
      live: {
        ...live,
        hostName: host?.username || 'Unknown',
        hostAvatar: host?.avatar || null,
      },
      gifts: gifts || [],
      viewers: viewers || [],
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/content/lives/:id/status ───────────────────────────────────

export async function updateLiveStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, reason = '' } = req.body;
    const allowed = ['live', 'ended', 'paused', 'banned'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    const { error } = await supabase.from('lives').update({ status }).eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    await logAction(req.admin?.id, req.admin?.name, `Live ${status}`, 'live', id, { reason });
    return res.json({ message: `Live session ${status} successfully.` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/random-sessions ────────────────────────────────────

export async function getRandomSessions(req, res) {
  try {
    const { search = '', statusFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    let countQ = supabase.from('chat_sessions').select('*', { count: 'exact', head: true });
    if (statusFilter) countQ = countQ.eq('status', statusFilter);

    const { count, error: countErr } = await countQ;
    if (countErr) {
      if (isMissingTable(countErr)) return res.json({ sessions: [], total: 0, page, limit });
      return res.status(500).json({ message: countErr.message });
    }

    const total = count || 0;
    if (total === 0 || offset >= total) return res.json({ sessions: [], total, page, limit });

    let q = supabase.from('chat_sessions').select('*');
    if (statusFilter) q = q.eq('status', statusFilter);
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });

    return res.json({ sessions: data || [], total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/premium-videos ─────────────────────────────────────
// Delegates to getVideos with isPremium=true — no separate DB query.

export async function getPremiumVideos(req, res) {
  req.query.isPremium = 'true';
  return getVideos(req, res);
}
