/**
 * Video and pornstar search via RapidAPI Pornhub Scraper.
 * Fallback: pornhub-api-xnxx POST /api/search when primary returns 429 or fails.
 */
import dotenv from 'dotenv';
import { xnxxSearch } from './xnxxSearchFallback.js';

dotenv.config();

const SCRAPER_HOST = process.env.RAPIDAPI_SCRAPER_HOST || 'pornhub-scraper-downloader.p.rapidapi.com';
const SCRAPER_KEY = process.env.RAPIDAPI_SCRAPER_KEY || '';
const SCRAPER_API_KEY = process.env.RAPIDAPI_SCRAPER_API_KEY || '';

const SEARCH_VIDEO_URL = `https://${SCRAPER_HOST}/api/pornhub/search`;
const SEARCH_PORNSTAR_URL = `https://${SCRAPER_HOST}/api/pornhub/search/pornstar`;

function isConfigured() {
  return Boolean(SCRAPER_KEY && SCRAPER_HOST);
}

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

function normalizeVideoItem(item, index, fallbackId) {
  const id = toStableVideoId(item?.id ?? item?.video_id ?? item?.url ?? item?.viewkey ?? fallbackId ?? `v-${index}`);
  const videoUrl = item?.videoUrl ?? item?.video_url ?? item?.url ?? item?.download_url ?? item?.mp4?.[0] ?? '';
  const thumbnailUrl = item?.thumbnailUrl ?? item?.thumbnail ?? item?.thumb ?? item?.thumbnail_url ?? item?.thumb_url ?? '';
  const duration = typeof item?.duration === 'number' ? item.duration : parseFloat(item?.duration) || 0;
  return {
    id: String(id),
    videoUrl: String(videoUrl || ''),
    thumbnailUrl: String(thumbnailUrl || ''),
    thumbnail: String(thumbnailUrl || ''),
    duration: Number(duration) || 0,
    title: item?.title ?? item?.title_clean ?? '',
    channel: item?.channel ?? item?.uploader ?? item?.channel_name ?? item?.pornstar?.[0] ?? '',
    views: item?.views ?? item?.views_count ?? 0,
  };
}

function extractVideoList(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body)) return body;
  const arr = body.data ?? body.videos ?? body.results ?? body.items ?? body.list ?? body.contents ?? (body.video ? [body.video] : []);
  return Array.isArray(arr) ? arr : [];
}

function normalizeXnxxItem(item, index) {
  const id = toStableVideoId(item?.id ?? item?.video_id ?? item?.url ?? item?.viewkey ?? `v-${index}`);
  const videoUrl = item?.video_url ?? item?.url ?? item?.link ?? item?.videoUrl ?? '';
  const thumb = item?.thumb ?? item?.thumbnail ?? item?.thumbnailUrl ?? item?.poster ?? item?.thumb_url ?? (item?.thumbs && item.thumbs[0]?.src);
  const thumbnailUrl = typeof thumb === 'string' ? thumb : (thumb?.src ?? thumb?.url ?? '');
  const duration = typeof item?.duration === 'number' ? item.duration : parseFloat(item?.duration) || 0;
  return {
    id: String(id),
    videoUrl: String(videoUrl || ''),
    thumbnailUrl: String(thumbnailUrl || ''),
    thumbnail: String(thumbnailUrl || ''),
    duration: Number(duration) || 0,
    title: item?.title ?? item?.title_clean ?? item?.name ?? '',
    channel: item?.channel ?? item?.uploader ?? item?.creator ?? item?.pornstar?.[0] ?? '',
    views: item?.views ?? item?.views_count ?? 0,
  };
}

async function tryXnxxSearchFallback(q, page) {
  const rawList = await xnxxSearch(q, page);
  return rawList.map((item, i) => normalizeXnxxItem(item, i));
}

/**
 * Search videos — GET /api/videos/search?q=Eva%20Elfie&filter=relevance&page=1
 */
export async function searchVideos(req, res) {
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const filter = String(req.query.filter || 'relevance').toLowerCase();
  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }
  if (!isConfigured()) {
    return res.status(503).json({ data: [], total: 0, page, totalPages: 0, error: 'Search API not configured' });
  }
  const url = new URL(SEARCH_VIDEO_URL);
  url.searchParams.set('query', q);
  url.searchParams.set('filter', filter === 'relevance' || filter === 'newest' || filter === 'mostviewed' ? filter : 'relevance');
  url.searchParams.set('page', String(page));
  const headers = {
    'x-rapidapi-key': SCRAPER_KEY,
    'x-rapidapi-host': SCRAPER_HOST,
    'Content-Type': 'application/json',
  };
  if (SCRAPER_API_KEY) headers['x-api-key'] = SCRAPER_API_KEY;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url.toString(), { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeoutId);
    const contentType = resp.headers.get('content-type') || '';
    const text = await resp.text();
    let body;
    try {
      body = contentType.includes('json') ? JSON.parse(text) : text;
    } catch {
      body = text;
    }
    if (resp.status === 429 || !resp.ok) {
      const fallbackList = await tryXnxxSearchFallback(q, page);
      if (fallbackList.length > 0) {
        const list = fallbackList.filter((item) => item.title && String(item.title).trim() !== '');
        const total = list.length;
        const totalPages = Math.max(1, Math.ceil(total / 20));
        return res.json({ data: list, total, page, totalPages, _fallback: 'xnxx-search' });
      }
      if (resp.status === 429) return res.status(429).json({ data: [], total: 0, page, totalPages: 0, error: 'Rate limit exceeded' });
      return res.status(resp.status).json({ data: [], total: 0, page, totalPages: 0, error: 'Search failed' });
    }
    const rawList = extractVideoList(body);
    const list = rawList
      .map((item, i) => normalizeVideoItem(item, i, `v-${i}`))
      .filter((item) => item.thumbnailUrl && String(item.thumbnailUrl).trim() !== '');
    const total = typeof body?.total === 'number' ? body.total : list.length;
    const totalPages = Math.max(1, Math.ceil(total / 20));
    return res.json({ data: list, total, page, totalPages });
  } catch (err) {
    clearTimeout(timeoutId);
    const fallbackList = await tryXnxxSearchFallback(q, page).catch(() => []);
    if (fallbackList.length > 0) {
      const list = fallbackList.filter((item) => item.title && String(item.title).trim() !== '');
      const total = list.length;
      const totalPages = Math.max(1, Math.ceil(total / 20));
      return res.json({ data: list, total, page, totalPages, _fallback: 'xnxx-search' });
    }
    return res.status(200).json({ data: [], total: 0, page, totalPages: 0 });
  }
}

/**
 * Search pornstars — GET /api/videos/search/pornstar?q=Eva%20Elfie&page=1
 */
export async function searchPornstars(req, res) {
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }
  if (!isConfigured()) {
    return res.status(503).json({ data: [], total: 0, page, totalPages: 0, error: 'Search API not configured' });
  }
  const url = new URL(SEARCH_PORNSTAR_URL);
  url.searchParams.set('query', q);
  url.searchParams.set('page', String(page));
  const headers = {
    'x-rapidapi-key': SCRAPER_KEY,
    'x-rapidapi-host': SCRAPER_HOST,
    'Content-Type': 'application/json',
  };
  if (SCRAPER_API_KEY) headers['x-api-key'] = SCRAPER_API_KEY;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url.toString(), { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeoutId);
    const contentType = resp.headers.get('content-type') || '';
    const text = await resp.text();
    let body;
    try {
      body = contentType.includes('json') ? JSON.parse(text) : text;
    } catch {
      body = text;
    }
    const rawList = extractVideoList(body);
    const list = Array.isArray(rawList) ? rawList : (body?.data ? (Array.isArray(body.data) ? body.data : []) : []);
    const normalize = (item, i) => ({
      id: item?.id ?? item?.slug ?? item?.name ?? `ps-${i}`,
      name: item?.name ?? item?.title ?? '',
      slug: item?.slug ?? item?.id ?? '',
      thumbnail: item?.thumbnail ?? item?.thumbnailUrl ?? item?.avatar ?? '',
      videoCount: item?.videoCount ?? item?.video_count ?? 0,
    });
    const data = list.map(normalize);
    const total = typeof body?.total === 'number' ? body.total : data.length;
    const totalPages = Math.max(1, Math.ceil(total / 20));
    return res.json({ data, total, page, totalPages });
  } catch (err) {
    clearTimeout(timeoutId);
    if (typeof process !== 'undefined' && !process.env.__searchPornstarWarned) {
      process.env.__searchPornstarWarned = '1';
      console.warn('Search pornstars error (will return empty):', err?.message || err);
    }
    return res.status(200).json({ data: [], total: 0, page, totalPages: 0 });
  }
}
