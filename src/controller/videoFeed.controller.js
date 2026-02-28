/**
 * Paginated video feed. Uses RapidAPI (Pornhub video/trending or downloader).
 * GET /api/videos?page=1&limit=20 → { data: Video[], total, page, totalPages }
 * Filters out items without thumbnail; merges totalLikes/totalComments from RTDB.
 */
import dotenv from 'dotenv';
import { rtdb } from '../config/firebase.js';

dotenv.config();

const CACHE_MAX_ITEMS = 500;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const VIDEO_BACKOFF_MS = 5 * 60 * 1000; // 5 min back-off after failure
let cache = { items: [], ts: 0 };
let lastVideoFailLogTs = 0;
let videoBackoffUntil = 0;

function logVideoFailOnce(msg) {
  const now = Date.now();
  if (now - lastVideoFailLogTs >= VIDEO_BACKOFF_MS) {
    lastVideoFailLogTs = now;
    console.warn('Video API:', msg);
  }
}

function isVideoApiConfigured() {
  return Boolean(
    process.env.RAPIDAPI_VIDEO_KEY &&
    process.env.RAPIDAPI_VIDEO_HOST &&
    process.env.RAPIDAPI_VIDEO_URL
  );
}

function isScraperConfigured() {
  return Boolean(
    process.env.RAPIDAPI_SCRAPER_KEY &&
    process.env.RAPIDAPI_SCRAPER_HOST
  );
}

/** Fallback: fetch videos via scraper search (e.g. "new" / newest) when main Video API fails. */
async function fetchFromScraperFallback() {
  if (!isScraperConfigured()) return [];
  const host = process.env.RAPIDAPI_SCRAPER_HOST;
  const url = `https://${host}/api/pornhub/search?query=new&filter=newest&page=1`;
  const headers = {
    'x-rapidapi-key': process.env.RAPIDAPI_SCRAPER_KEY,
    'x-rapidapi-host': host,
    'Content-Type': 'application/json',
  };
  if (process.env.RAPIDAPI_SCRAPER_API_KEY) headers['x-api-key'] = process.env.RAPIDAPI_SCRAPER_API_KEY;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return [];
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    let body;
    try {
      body = contentType.includes('json') ? JSON.parse(text) : text;
    } catch {
      return [];
    }
    return normalizeApiResponse(body);
  } catch {
    clearTimeout(timeoutId);
    return [];
  }
}

/** Extract path-safe id (e.g. viewkey from Pornhub URL) so routes stay valid. */
function toStableVideoId(raw) {
  const s = String(raw || '');
  const viewkeyMatch = s.match(/[?&]viewkey=([^&]+)/);
  if (viewkeyMatch) return viewkeyMatch[1];
  if (s.startsWith('http') || s.includes('/')) {
    const slug = s.replace(/^.*\//, '').split('?')[0];
    if (slug && slug.length < 80) return slug;
  }
  return s || raw;
}

function normalizeVideo(item, index, fallbackId) {
  let id = item?.id ?? item?.video_id ?? item?.url ?? fallbackId ?? `v-${index}`;
  id = toStableVideoId(id);
  const videoUrl = item?.videoUrl ?? item?.video_url ?? item?.url ?? item?.download_url ?? item?.mp4?.[0] ?? '';
  const thumbnailUrl = item?.thumbnailUrl ?? item?.thumbnail ?? item?.thumb ?? item?.thumbnail_url ?? '';
  const duration = typeof item?.duration === 'number' ? item.duration : parseFloat(item?.duration) || 0;
  const createdAt = item?.createdAt ?? item?.created_at ?? item?.date ?? new Date().toISOString();
  return {
    id: String(id),
    videoUrl: String(videoUrl || ''),
    thumbnailUrl: String(thumbnailUrl || ''),
    duration: Number(duration) || 0,
    createdAt,
    title: item?.title ?? item?.title_clean ?? '',
    channel: item?.channel ?? item?.uploader ?? item?.channel_name ?? '',
    views: item?.views ?? item?.views_count ?? 0,
  };
}

function normalizeApiResponse(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body)) return body.map((item, i) => normalizeVideo(item, i, `v-${i}`));
  const arr =
    body.data ??
    body.videos ??
    body.results ??
    body.items ??
    (body.video ? [body.video] : []) ??
    body.list ??
    body.contents ??
    [];
  const list = Array.isArray(arr) ? arr : [];
  return list.map((item, i) => normalizeVideo(item, i, `v-${i}`));
}

async function fetchFromRapidApi() {
  const url = process.env.RAPIDAPI_VIDEO_URL;
  const host = (process.env.RAPIDAPI_VIDEO_HOST || '').toLowerCase();
  const isPost = host.includes('downloader') || process.env.RAPIDAPI_VIDEO_METHOD === 'POST';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  const options = {
    method: isPost ? 'POST' : 'GET',
    headers: {
      'x-rapidapi-key': process.env.RAPIDAPI_VIDEO_KEY,
      'x-rapidapi-host': process.env.RAPIDAPI_VIDEO_HOST,
      ...(isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    signal: controller.signal,
  };
  if (isPost) options.body = new URLSearchParams({});

  try {
    const res = await fetch(url, options);
    clearTimeout(timeoutId);
    if (!res.ok) {
      videoBackoffUntil = Date.now() + VIDEO_BACKOFF_MS;
      logVideoFailOnce(res.status === 429 ? 'rate limit (429)' : `HTTP ${res.status}`);
      return [];
    }
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    let body;
    try {
      body = contentType.includes('json') ? JSON.parse(text) : text;
    } catch {
      body = text;
    }
    return normalizeApiResponse(body);
  } catch (err) {
    clearTimeout(timeoutId);
    videoBackoffUntil = Date.now() + VIDEO_BACKOFF_MS;
    logVideoFailOnce(err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return [];
  }
}

export async function getVideosPaginated(page = 1, limit = 20) {
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));

  if (!isVideoApiConfigured() && !isScraperConfigured()) {
    return { data: [], total: 0, page: pageNum, totalPages: 0 };
  }

  let items = [];
  const now = Date.now();
  const cacheValid = cache.items.length > 0 && now - cache.ts < CACHE_TTL_MS;
  const inBackoff = now < videoBackoffUntil;
  const cacheEmpty = cache.items.length === 0;

  if (cacheValid) {
    items = cache.items;
  } else if (inBackoff && !cacheEmpty) {
    items = cache.items;
  } else {
    if (isVideoApiConfigured()) {
      items = await fetchFromRapidApi();
    }
    if (items.length === 0 && isScraperConfigured()) {
      items = await fetchFromScraperFallback();
    }
    if (items.length > 0) {
      cache = { items: items.slice(0, CACHE_MAX_ITEMS), ts: now };
    } else if (cache.items.length > 0) {
      items = cache.items;
    }
  }

  // Only show videos with an active thumbnail
  items = items.filter((item) => item.thumbnailUrl && String(item.thumbnailUrl).trim() !== '');

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limitNum));
  const start = (pageNum - 1) * limitNum;
  const data = items.slice(start, start + limitNum);

  // Ensure RTDB ref per video and merge totalLikes / totalComments
  try {
    const rtdbRef = rtdb.ref('videos');
    await Promise.all(
      data.map(async (item) => {
        const ref = rtdbRef.child(String(item.id));
        const snap = await ref.once('value');
        let val = snap.val();
        if (!val) {
          await ref.set({ externalId: String(item.id), totalLikes: 0, totalComments: 0 });
          val = { totalLikes: 0, totalComments: 0 };
        }
        item.totalLikes = val.totalLikes ?? 0;
        item.totalComments = val.totalComments ?? 0;
        return item;
      })
    );
  } catch (err) {
    console.warn('videoFeed RTDB merge:', err?.message || err);
    data.forEach((item) => {
      item.totalLikes = item.totalLikes ?? 0;
      item.totalComments = item.totalComments ?? 0;
    });
  }

  return {
    data,
    total,
    page: pageNum,
    totalPages,
  };
}

/**
 * Get a single video by id (from feed cache or RTDB counts for external ref).
 * GET /api/videos/:id
 */
export async function getVideoById(id) {
  const videoId = String(id || '').trim();
  if (!videoId) return null;

  if (!isVideoApiConfigured() && !isScraperConfigured()) return null;

  let items = [];
  const now = Date.now();
  if (cache.items.length > 0 && now - cache.ts < CACHE_TTL_MS) {
    items = cache.items;
  } else {
    if (isVideoApiConfigured()) items = await fetchFromRapidApi();
    if (items.length === 0 && isScraperConfigured()) items = await fetchFromScraperFallback();
    if (items.length > 0) cache = { items: items.slice(0, CACHE_MAX_ITEMS), ts: now };
  }

  items = items.filter((item) => item.thumbnailUrl && String(item.thumbnailUrl).trim() !== '');
  let video = items.find((item) => String(item.id) === videoId);
  if (!video) {
    video = items.find((item) => toStableVideoId(item.id) === videoId);
  }
  if (!video) return null;

  try {
    const ref = rtdb.ref('videos').child(videoId);
    const snap = await ref.once('value');
    const val = snap.val();
    if (!val) {
      await ref.set({ externalId: videoId, totalLikes: 0, totalComments: 0 });
      video.totalLikes = 0;
      video.totalComments = 0;
    } else {
      video.totalLikes = val.totalLikes ?? 0;
      video.totalComments = val.totalComments ?? 0;
    }
  } catch (err) {
    video.totalLikes = video.totalLikes ?? 0;
    video.totalComments = video.totalComments ?? 0;
  }
  return video;
}
