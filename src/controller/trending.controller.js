/**
 * Trending / home list via RapidAPI xnxx-api GET /xn/best?page=
 * (No Pornhub / pornhub2 hosts.)
 */
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import { isXnxxApiConfigured, fetchXnxxBestPage } from '../utils/xnxxRapidApi.js';

const PER_PAGE_HINT = 18;

/**
 * GET /api/videos/trending?page=1
 */
export async function getTrending(req, res) {
  if (!isXnxxApiConfigured()) {
    return res.status(503).json({
      success: false,
      data: [],
      hasMore: false,
      error: 'Video feed not configured. Set RAPIDAPI_XNXX_API_KEY in backend .env',
    });
  }
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  try {
    const { ok, items, status, raw } = await fetchXnxxBestPage(page);
    if (!ok) {
      console.warn('[trending] xn/best failed', status, typeof raw === 'string' ? raw.slice(0, 200) : '');
      return res.json({
        success: true,
        data: [],
        hasMore: false,
        _warning: 'XNXX best feed unavailable',
      });
    }
    ingestHomeFeedVideos(items);
    const hasMore = items.length >= PER_PAGE_HINT;
    console.log('Video API Response: trending (xn/best)', { page, count: items.length, hasMore });
    return res.json({ success: true, data: items, hasMore, page });
  } catch (err) {
    console.warn('trending.controller getTrending:', err?.message || err);
    return res.json({
      success: true,
      data: [],
      hasMore: false,
      _warning: 'Trending upstream unavailable',
    });
  }
}
