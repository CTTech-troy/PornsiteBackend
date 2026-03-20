/**
 * Video search: primary RapidAPI xnxx-api (GET /xn/search), fallback porn-xnxx-api (POST /search).
 */
import dotenv from 'dotenv';
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import { isXnxxApiConfigured, fetchXnxxSearch } from '../utils/xnxxRapidApi.js';

dotenv.config();

function homeCardToSearchItem(card) {
  if (!card) return null;
  const preview = String(card.previewVideo || '').trim();
  const page = String(card.videoSrc || '').trim();
  return {
    id: String(card.id),
    videoUrl: preview || page,
    previewVideo: preview,
    thumbnailUrl: String(card.thumbnail || ''),
    thumbnail: String(card.thumbnail || ''),
    duration: Number(card.durationSeconds) || 0,
    title: card.title || '',
    channel: card.channel || '',
    views: card.views ?? 0,
  };
}

/**
 * GET /api/videos/search?q=Eva%20Elfie&filter=relevance&page=1
 */
export async function searchVideos(req, res) {
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const filter = String(req.query.filter || 'relevance').toLowerCase();
  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }
  if (!isXnxxApiConfigured()) {
    return res.status(503).json({
      data: [],
      total: 0,
      page,
      totalPages: 0,
      error: 'Search not configured. Set RAPIDAPI_XNXX_API_KEY in backend .env',
    });
  }
  const f =
    filter === 'relevance' || filter === 'newest' || filter === 'mostviewed' ? filter : 'relevance';
  const { ok, items: cards, status, raw } = await fetchXnxxSearch(q, page, f);
  if (!ok) {
    console.warn('[search] xn/search failed', status, typeof raw === 'string' ? raw.slice(0, 120) : raw);
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      data: [],
      total: 0,
      page,
      totalPages: 0,
      error: typeof raw === 'string' ? raw.slice(0, 200) : 'Search upstream error',
    });
  }
  ingestHomeFeedVideos(cards);
  const list = cards.map(homeCardToSearchItem).filter((item) => item && item.thumbnailUrl && String(item.thumbnailUrl).trim() !== '');
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / 20));
  return res.json({ data: list, total, page, totalPages });
}

/**
 * GET /api/videos/search/pornstar?q=...&page=1 — not provided by xnxx-api; returns empty.
 */
export async function searchPornstars(req, res) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  return res.json({ data: [], total: 0, page, totalPages: 0 });
}
