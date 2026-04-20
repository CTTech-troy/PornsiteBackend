/**
 * Home feed via RapidAPI xnxx-api GET /xn/best?page=
 * Fetches multiple sequential pages in one request for a full first screen + smooth infinite scroll.
 */
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import { fetchXnxxBestPage, isXnxxApiConfigured } from '../utils/xnxxRapidApi.js';

const MIN_PAGES = 1;
const MAX_PAGES = 5;
const PER_PAGE_ESTIMATE = 20;

/**
 * GET /api/videos/home-feed?page=1&pages=3
 * page = starting page (1-based)
 * pages = how many /xn/best pages to merge (1-5, default 3)
 */
export async function getHomeFeed(req, res) {
  if (!isXnxxApiConfigured()) {
    return res.status(503).json({
      success: false,
      data: [],
      hasMore: false,
      error: 'Home feed not configured. Set RAPIDAPI_XNXX_API_KEY in backend .env',
    });
  }

  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pagesCount = Math.min(MAX_PAGES, Math.max(MIN_PAGES, parseInt(req.query.pages, 10) || 3));

    const pageNumbers = Array.from({ length: pagesCount }, (_, i) => page + i);
    const merged = [];
    const seenIds = new Set();

    for (const p of pageNumbers) {
      const { ok, items } = await fetchXnxxBestPage(p);
      if (!ok || !items?.length) break;
      for (let i = 0; i < items.length; i++) {
        const card = items[i];
        if (!card) continue;
        if (!card.videoSrc || typeof card.videoSrc !== 'string' || !card.videoSrc.startsWith('http')) {
          console.warn('[Video API] Home-feed video missing or invalid video_url:', { id: card.id, index: merged.length });
        }
        const id = card.id;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        merged.push(card);
      }
    }

    const hasMore = merged.length >= PER_PAGE_ESTIMATE * pagesCount;
    const nextPage = page + pagesCount;
    console.log('Video API Response: home-feed (xn/best)', { page, pagesCount, count: merged.length, hasMore });

    ingestHomeFeedVideos(merged);

    return res.json({
      success: true,
      data: merged,
      hasMore,
      nextPage,
      page,
      q: 'best',
    });
  } catch (err) {
    console.error('[homeFeed] getHomeFeed error:', err?.message || err);
    return res.status(500).json({ success: false, data: [], hasMore: false, error: err?.message || 'Failed to load home feed' });
  }
}
