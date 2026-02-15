import express from 'express';
import { searchVideos, downloadVideo, normalizeExternalVideos, getCategories, getUserByNickname, getPornstarByNickname, getChannelBySlug } from '../controller/videos.controller.js';
import { getMediaByUser } from '../config/dbFallback.js';
import { supabase, isConfigured } from '../config/supabase.js';
import { rtdb } from '../config/firebase.js';

const router = express.Router();

// Simple server-side proxy for pornhub RapidAPI trending endpoint.
// This avoids CORS issues when the frontend attempts to call RapidAPI directly.
router.get('/trending-proxy', async (req, res) => {
  const page = req.query.page || '1';
  try {
    const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
    const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'pornhub-api-xnxx.p.rapidapi.com';
    if (!RAPIDAPI_KEY) return res.status(500).json({ ok: false, error: 'Missing RAPIDAPI_KEY on server' });
    const paths = ['/api/trending', '/trending'];
    let lastErrBody = null;
    for (const p of paths) {
      const url = `https://${RAPIDAPI_HOST}${p}?page=${encodeURIComponent(page)}`;
      const options = { method: 'GET', headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } };
      try {
        const r = await fetch(url, options);
        const contentType = r.headers.get('content-type') || '';
        let body;
        if (contentType.includes('application/json')) body = await r.json();
        else body = await r.text();
        if (r.ok) {
          const upstreamList = Array.isArray(body) ? body : (body?.data || body?.results || body?.videos || body);
          // normalize and log inside controller
          const mapped = normalizeExternalVideos(upstreamList || []);
          return res.json({ ok: true, status: r.status, count: mapped.length, data: mapped });
        }
        // not ok - record body and try next path
        lastErrBody = body;
        console.warn('trending-proxy upstream non-OK', { path: p, status: r.status, body });
      } catch (e) {
        lastErrBody = { error: e && e.message ? e.message : String(e) };
        console.error('trending-proxy fetch error for path', p, lastErrBody);
      }
    }
    // If we reach here, all attempts failed — try DB fallback
    try {
      const dbItems = await fetchTrendingFromDB(page);
      return res.status(200).json({ ok: true, source: 'db', count: dbItems.length, data: dbItems, note: 'Returned DB fallback because upstream failed', details: lastErrBody });
    } catch (dbErr) {
      return res.status(502).json({ ok: false, error: 'Upstream trending endpoints failed and DB fallback failed', details: lastErrBody, dbError: dbErr && dbErr.message ? dbErr.message : String(dbErr) });
    }
  } catch (err) {
    console.error('trending-proxy error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// Helper: fetch trending items from DB (Supabase preferred, RTDB fallback)
async function fetchTrendingFromDB(page = 1, perPage = 24) {
  const p = parseInt(page, 10) || 1;
  const offset = (p - 1) * perPage;
  // Try Supabase first. Allow configurable table and graceful fallback if table missing.
  if (isConfigured()) {
    const preferredTable = process.env.SUPABASE_TRENDING_TABLE || 'media';
    const candidateTables = [preferredTable, 'videos', 'media', 'media_items'];
    for (const tbl of candidateTables) {
      try {
        const { data, error } = await supabase
          .from(tbl)
          .select('*')
          .order('views', { ascending: false })
          .range(offset, offset + perPage - 1);
        if (error) throw error;
        return Array.isArray(data) ? data : [];
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        // If error indicates table not found, try next candidate; otherwise log and break to RTDB fallback
        if (/could not find table|table .* does not exist|relation .* does not exist/i.test(msg)) {
          console.warn(`Supabase table '${tbl}' not found, trying next candidate. (${msg})`);
          continue;
        }
        console.warn('Supabase trending fetch failed, falling back to RTDB:', msg);
        break;
      }
    }
  }

  // RTDB fallback
  try {
    const snap = await rtdb.ref('media').once('value');
    const val = snap.val();
    if (!val) return [];
    const arr = Object.keys(val).map(k => val[k]);
    // sort by numeric views if present
    arr.sort((a, b) => {
      const va = Number(a.views) || Number(a.view_count) || 0;
      const vb = Number(b.views) || Number(b.view_count) || 0;
      return vb - va;
    });
    return arr.slice(offset, offset + perPage);
  } catch (err) {
    console.error('RTDB trending fetch failed:', err && err.message ? err.message : err);
    throw err;
  }
}

// Expose a direct DB trending endpoint
router.get('/trending', async (req, res) => {
  const page = req.query.page || '1';
  try {
    const items = await fetchTrendingFromDB(page);
    // Normalize items to frontend-friendly shape
    const normalized = (items || []).map((it) => ({
      id: it.id || it.video_id || it.path || (it.url ? it.url.split('/').pop() : ''),
      title: it.title || it.name || it.caption || it.video_title || '',
      // support common column names from your Supabase schema
      thumbnail: it.thumbnail || it.thumbnail_url || it.preview || it.poster || it.thumb || it.previewImage || '',
      // video URL may be stored as `url`, `video_url`, or `videoUrl`
      url: it.url || it.video_url || it.videoUrl || it.publicUrl || (it.path ? `${process.env.SUPABASE_URL?.replace(/\/$/, '')}/storage/v1/object/public/${it.bucket || ''}/${encodeURIComponent(it.path || '')}` : ''),
      views: (it.views ?? it.view_count ?? 0),
      likes: it.likes || it.like_count || '0',
      duration: it.duration || it.length || '',
      raw: it
    }));
    res.json({ ok: true, count: normalized.length, data: normalized });
  } catch (err) {
    console.error('trending.db error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// GET /api/videos/search?q=...  -> proxies to RapidAPI search
router.get('/search', async (req, res) => {
  // do not default to 'trending' — let caller decide query. Empty query is valid.
  const q = req.query.q || '';
  try {
    const result = await searchVideos(q);
    // If searchVideos returned aggregated host results (array of {host, result|error}),
    // merge their payloads into a single list for the frontend to consume.
    if (Array.isArray(result?.body) && result.body.length && result.body[0] && (result.body[0].result || result.body[0].error)) {
      const merged = [];
      for (const entry of result.body) {
        try {
          if (entry.result && entry.result.body) {
            const dataPart = entry.result.body;
            if (Array.isArray(dataPart)) merged.push(...dataPart);
            else if (Array.isArray(dataPart?.data)) merged.push(...dataPart.data);
            else if (Array.isArray(dataPart?.results)) merged.push(...dataPart.results);
            else if (Array.isArray(dataPart?.videos)) merged.push(...dataPart.videos);
          }
        } catch (e) {
          // ignore individual host parsing errors
          console.warn('Error merging host result', e && e.message ? e.message : e);
        }
      }
      return res.json({ ok: true, status: result.status || 200, data: merged });
    }

    // For single-host results, if upstream returned an error status, forward it
    if (result && result.status && result.status >= 400) {
      return res.status(result.status).json({ ok: false, status: result.status, error: result.body || 'Upstream error' });
    }

    // Normalize single-host body shapes into an array when possible
    const body = result?.body;
    if (Array.isArray(body)) return res.json({ ok: true, status: result.status || 200, data: body });
    if (body && Array.isArray(body.data)) return res.json({ ok: true, status: result.status || 200, data: body.data });
    if (body && Array.isArray(body.results)) return res.json({ ok: true, status: result.status || 200, data: body.results });
    if (body && Array.isArray(body.videos)) return res.json({ ok: true, status: result.status || 200, data: body.videos });

    // Fallback: return body directly so frontend can inspect structure
    return res.json({ ok: true, status: result.status || 200, data: body });
  } catch (err) {
    console.error('videos.search error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// POST /api/videos/download  { link }
router.post('/download', async (req, res) => {
  const { link } = req.body || {};
  if (!link) return res.status(400).json({ ok: false, error: 'missing link' });
  try {
    const result = await downloadVideo(link);
    res.json({ ok: true, status: result.status, data: result.body });
  } catch (err) {
    console.error('videos.download error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

export default router;

// GET /api/videos/user/:userId  -> list media uploaded by a user
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing userId' });
  try {
    const rows = await getMediaByUser(userId);
    // normalize to frontend-friendly shape
    const items = (rows || []).map(r => ({
      id: r.id || r.path || (r.url ? r.url.split('/').pop() : Date.now().toString()),
      title: r.title || r.name || '',
      url: r.url || r.publicUrl || r.url || (r.path ? `${process.env.SUPABASE_URL?.replace(/\/$/, '')}/storage/v1/object/public/${r.bucket || ''}/${encodeURIComponent(r.path || '')}` : ''),
      type: r.type || (r.bucket && r.bucket.includes('image') ? 'image' : 'video'),
      created_at: r.created_at || r.createdAt || r.created || null,
      raw: r,
    }));

    res.json({ ok: true, count: items.length, data: items });
  } catch (err) {
    console.error('videos.user error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// GET /api/videos/categories
router.get('/categories', async (req, res) => {
  try {
    const cats = await getCategories();
    return res.json({ ok: true, count: Array.isArray(cats) ? cats.length : 0, data: cats });
  } catch (err) {
    console.error('videos.categories error', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// GET /api/videos/pornstar/:nickname
router.get('/pornstar/:nickname', async (req, res) => {
  const { nickname } = req.params;
  if (!nickname) return res.status(400).json({ ok: false, error: 'missing nickname' });
  try {
    const profile = await getPornstarByNickname(nickname);
    return res.json({ ok: true, data: profile });
  } catch (err) {
    console.error('videos.pornstar error', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// GET /api/videos/user/:nickname/profile
router.get('/user/profile/:nickname', async (req, res) => {
  const { nickname } = req.params;
  if (!nickname) return res.status(400).json({ ok: false, error: 'missing nickname' });
  try {
    const profile = await getUserByNickname(nickname);
    return res.json({ ok: true, data: profile });
  } catch (err) {
    console.error('videos.user.profile error', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// GET /api/videos/channel/:slug
router.get('/channel/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!slug) return res.status(400).json({ ok: false, error: 'missing slug' });
  try {
    const channel = await getChannelBySlug(slug);
    return res.json({ ok: true, data: channel });
  } catch (err) {
    console.error('videos.channel error', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
