/**
 * Trending / home feed: creator-published videos from Supabase first (all live public listings, including premium).
 * Optional RapidAPI xnxx pages are appended after for extra variety when configured.
 */
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import { fetchXnxxBestPage, isXnxxApiConfigured } from '../utils/xnxxRapidApi.js';
import { fetchPublishedHomeCards } from '../utils/platformPublicFeed.js';

const MIN_PAGES = 1;
const MAX_PAGES = 5;

/**
 * GET /api/videos/home-feed?page=1&pages=3
 * page = starting page (1-based)
 * pages = how many /xn/best pages to merge (1-5, default 3)
 */
export async function getHomeFeed(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pagesCount = Math.min(MAX_PAGES, Math.max(MIN_PAGES, parseInt(req.query.pages, 10) || 3));

    const merged = await fetchPublishedHomeCards({ page, pagesCount, viewerUid: req.uid || null });
    const seenIds = new Set(merged.map((c) => (c?.id != null ? String(c.id) : '')).filter(Boolean));

    if (isXnxxApiConfigured()) {
      const pageNumbers = Array.from({ length: pagesCount }, (_, i) => page + i);
      for (const p of pageNumbers) {
        const { ok, items } = await fetchXnxxBestPage(p);
        if (!ok || !items?.length) continue;
        for (let i = 0; i < items.length; i++) {
          const card = items[i];
          if (!card) continue;
          const extId = card.id != null ? String(card.id) : '';
          if (!extId || seenIds.has(extId)) continue;
          seenIds.add(extId);
          merged.push(card);
        }
      }
    }

    ingestHomeFeedVideos(merged);

    const expectedPageSize = Math.min(200, 20 * pagesCount);
    const hasMore = merged.length >= expectedPageSize;
    const nextPage = page + pagesCount;

    console.log('Video API Response: home-feed', {
      page,
      pagesCount,
      count: merged.length,
      hasMore,
      platformFirst: true,
    });

    return res.json({
      success: true,
      data: merged,
      hasMore,
      nextPage,
      page,
      q: 'creators',
    });
  } catch (err) {
    console.error('[homeFeed] getHomeFeed error:', err?.message || err);
    return res.status(500).json({ success: false, data: [], hasMore: false, error: err?.message || 'Failed to load home feed' });
  }
}
