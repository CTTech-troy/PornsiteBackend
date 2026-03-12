/**
 * Trending videos via RapidAPI pornhub-api-xnxx.
 * GET /api/videos/trending?page=1
 * Fallback: pornhub2 v2/search?search=trending if xnxx returns empty.
 */
const TRENDING_HOST = process.env.RAPIDAPI_TRENDING_HOST || 'pornhub-api-xnxx.p.rapidapi.com';
const TRENDING_KEY = process.env.RAPIDAPI_TRENDING_KEY || process.env.RAPIDAPI_KEY || '';
const FALLBACK_HOST = process.env.RAPIDAPI_VIDEO_HOST || process.env.RAPIDAPI_HOST || 'pornhub2.p.rapidapi.com';
const FALLBACK_KEY = process.env.RAPIDAPI_VIDEO_KEY || process.env.RAPIDAPI_KEY || '';

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

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return '0:00';
  const n = Math.floor(Number(seconds));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function extractVideosFromResponse(data) {
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
    duration: formatDuration(v.duration),
    durationSeconds: parseDurationToSeconds(v.duration) || Number(v.duration) || 0,
    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(String(v.video_id || v.id || title)).slice(0, 50)}`,
    videoSrc: v.url ?? v.video_url ?? v.link ?? v.video_link ?? '',
    likes: v.rating ?? '0',
    comments: '0',
    time: v.time ?? v.added ?? v.upload_date ?? '',
    description: title ? `Watch ${title}.` : 'Watch this video.',
  };
}

function isConfigured() {
  return Boolean(
    (TRENDING_KEY && TRENDING_KEY.length >= 10 && TRENDING_KEY !== 'YOUR_API_KEY') ||
    (FALLBACK_KEY && FALLBACK_KEY.length >= 10 && FALLBACK_KEY !== 'YOUR_API_KEY')
  );
}

/** Fetch from pornhub2 v2/search?search=trending as fallback */
async function fetchPornhub2Trending(page) {
  if (!FALLBACK_KEY || FALLBACK_KEY.length < 10) return [];
  const url = `https://${FALLBACK_HOST}/v2/search?${new URLSearchParams({
    search: 'trending',
    page: String(page),
    period: 'weekly',
    ordering: 'newest',
    thumbsize: 'small',
  })}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'x-rapidapi-key': FALLBACK_KEY, 'x-rapidapi-host': FALLBACK_HOST },
  });
  if (!res.ok) return [];
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  return extractVideosFromResponse(data);
}

/**
 * GET /api/videos/trending?page=1
 */
export async function getTrending(req, res) {
  if (!isConfigured()) {
    return res.status(503).json({ success: false, data: [], hasMore: false, error: 'Trending API not configured. Set RAPIDAPI_TRENDING_KEY or RAPIDAPI_VIDEO_KEY in backend .env' });
  }
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const tryPrimary = TRENDING_KEY && TRENDING_KEY.length >= 10 && TRENDING_KEY !== 'YOUR_API_KEY';
  const controller = new AbortController();
  let timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    let list = [];
    if (tryPrimary) {
      const url = `https://${TRENDING_HOST}/api/trending?page=${encodeURIComponent(String(page))}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'x-rapidapi-key': TRENDING_KEY, 'x-rapidapi-host': TRENDING_HOST },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      timeoutId = null;
      if (response.ok) {
        const raw = await response.text();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          // fall through to fallback
        }
        if (data) list = extractVideosFromResponse(data);
      }
      if (list.length === 0 && (response.status === 429 || !response.ok)) {
        list = await fetchPornhub2Trending(page);
      }
    }
    if (list.length === 0) {
      list = await fetchPornhub2Trending(page);
    }
    const items = list.map((v, i) => mapToCard(v, i)).filter(Boolean);
    const hasMore = items.length >= 20;
    return res.json({ success: true, data: items, hasMore });
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      const fallbackList = await fetchPornhub2Trending(page);
      const items = fallbackList.map((v, i) => mapToCard(v, i)).filter(Boolean);
      return res.json({ success: true, data: items, hasMore: items.length >= 20, _fallback: 'pornhub2' });
    }
    const fallbackList = await fetchPornhub2Trending(page).catch(() => []);
    const items = fallbackList.map((v, i) => mapToCard(v, i)).filter(Boolean);
    if (items.length > 0) return res.json({ success: true, data: items, hasMore: items.length >= 20, _fallback: 'pornhub2' });
    console.error('trending.controller getTrending:', err?.message || err);
    return res.status(500).json({ success: false, data: [], hasMore: false, error: err?.message || 'Failed' });
  }
}
