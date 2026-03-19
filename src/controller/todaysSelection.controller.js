/**
 * GET /api/videos/todays-selection
 * Proxies RapidAPI xnxx-api "Today's selection" (key in .env, not exposed to browser).
 */
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';

const HOST = process.env.RAPIDAPI_XNXX_HOST || 'xnxx-api.p.rapidapi.com';
const KEY =
  process.env.RAPIDAPI_XNXX_API_KEY ||
  process.env.RAPIDAPI_XNXX_KEY ||
  process.env.RAPIDAPI_KEY ||
  '';

function parseDurationToSeconds(val) {
  if (val == null || val === '') return 0;
  const n = Number(val);
  if (!Number.isNaN(n) && n >= 0) return Math.floor(n);
  const s = String(val).trim();
  const parts = s.split(':').map(Number);
  if (parts.length === 2 && parts.every((p) => !Number.isNaN(p))) {
    const [m, sec] = parts;
    return Math.max(0, Math.floor(m) * 60 + Math.floor(sec));
  }
  if (parts.length === 3 && parts.every((p) => !Number.isNaN(p))) {
    const [h, m, sec] = parts;
    return Math.max(0, Math.floor(h) * 3600 + Math.floor(m) * 60 + Math.floor(sec));
  }
  return 0;
}

function getDurationSeconds(v) {
  if (!v || typeof v !== 'object') return 0;
  const raw = v.duration ?? v.length ?? v.runtime ?? v.duration_formatted ?? v.duration_sec;
  const sec = parseDurationToSeconds(raw);
  if (sec > 0) return sec;
  return parseDurationToSeconds(v.duration) || Number(v.duration) || 0;
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return '0:00';
  const n = Math.floor(Number(seconds));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function extractVideos(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data)) return data;
  const list =
    data.videos ??
    data.data ??
    (data.data && Array.isArray(data.data.videos) ? data.data.videos : null) ??
    (data.data && Array.isArray(data.data) ? data.data : null) ??
    data.results ??
    data.items ??
    data.list ??
    data.contents ??
    [];
  return Array.isArray(list) ? list : [];
}

function mapToCard(v, index) {
  if (!v || typeof v !== 'object') return null;
  const title = v.title || v.title_clean || v.name || v.video_title || 'Video';
  const thumb =
    v.thumb ??
    v.thumbnail ??
    v.thumbnailUrl ??
    v.poster ??
    v.thumb_url ??
    v.image ??
    v.preview ??
    v.default_thumb ??
    (v.thumbs && (v.thumbs[0]?.src ?? v.thumbs[0])) ??
    (v.thumbnails && (v.thumbnails[0]?.url ?? v.thumbnails[0])) ??
    '';
  const thumbStr = typeof thumb === 'string' ? thumb : (thumb?.src ?? thumb?.url ?? thumb?.href ?? '');
  return {
    id: v.video_id ?? v.id ?? v.key ?? v.url ?? v.viewkey ?? `v-${index}-${Math.random().toString(36).slice(2)}`,
    title: String(title),
    channel: v.channel ?? v.uploader ?? v.creator ?? v.uploader_name ?? (v.pornstars && (Array.isArray(v.pornstars) ? v.pornstars[0] : v.pornstars)) ?? 'Creator',
    views: v.views ?? v.views_count ?? v.view_count ?? 0,
    thumbnail: thumbStr,
    duration: formatDuration(getDurationSeconds(v)),
    durationSeconds: getDurationSeconds(v),
    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(String(v.video_id || v.id || title)).slice(0, 50)}`,
    videoSrc: v.url ?? v.video_url ?? v.link ?? v.video_link ?? '',
    likes: v.rating ?? '0',
    comments: '0',
    time: v.time ?? v.added ?? v.upload_date ?? '',
    description: title ? `Watch ${title}.` : 'Watch this video.',
  };
}

export async function getTodaysSelection(req, res) {
  if (!KEY || KEY.length < 10 || KEY === 'YOUR_API_KEY') {
    return res.status(503).json({
      success: false,
      data: [],
      error: 'Today\'s selection API not configured. Set RAPIDAPI_XNXX_API_KEY (or RAPIDAPI_XNXX_KEY) in backend .env',
    });
  }
  const url = `https://${HOST}/xn/todays-selection`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': KEY,
        'x-rapidapi-host': HOST,
        'Content-Type': 'application/json',
      },
    });
    const raw = await response.text();
    if (!response.ok) {
      console.warn('[todays-selection] upstream', response.status, raw.slice(0, 200));
      return res.status(response.status >= 400 ? response.status : 502).json({
        success: false,
        data: [],
        error: raw.slice(0, 200) || response.statusText,
      });
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({ success: false, data: [], error: 'Invalid JSON from upstream' });
    }
    const list = extractVideos(data);
    const items = list.map((v, i) => mapToCard(v, i)).filter(Boolean);
    ingestHomeFeedVideos(items);
    console.log('Video API Response: todays-selection', { count: items.length });
    return res.json({ success: true, data: items, hasMore: false });
  } catch (err) {
    console.error('todaysSelection.controller:', err?.message || err);
    return res.status(502).json({
      success: false,
      data: [],
      error: err?.message || 'Failed to fetch today\'s selection',
    });
  }
}
