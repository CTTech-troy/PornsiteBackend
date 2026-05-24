import { fetchXnxxBestPage, isXnxxApiConfigured } from '../utils/xnxxRapidApi.js';
import { fetchPublishedHomeCards } from '../utils/platformPublicFeed.js';
import { filterHomeFeedVideos } from '../utils/videoPlaybackValidation.js';
import { loadExternalFeedConfig } from '../services/externalFeedConfig.service.js';
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';

export async function getTrending(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const creatorCards = await fetchPublishedHomeCards({ page, pagesCount: 1, viewerUid: req.uid || null });
    const merged = [...creatorCards];
    const seen = new Set(merged.map((c) => String(c.id)));

    const feedConfig = await loadExternalFeedConfig();
    if (feedConfig.enabled && isXnxxApiConfigured()) {
      const { ok, items } = await fetchXnxxBestPage(page);
      if (ok && items?.length) {
        for (const card of filterHomeFeedVideos(items)) {
          const id = String(card.id);
          if (seen.has(id)) continue;
          seen.add(id);
          merged.push(card);
        }
      }
    }

    merged.sort((a, b) => Number(b.views || b.totalViews || 0) - Number(a.views || a.totalViews || 0));
    const data = merged.slice(0, limit);
    ingestHomeFeedVideos(data);

    return res.json({
      success: true,
      data,
      hasMore: merged.length > limit,
      page,
    });
  } catch (err) {
    console.error('[trending] error:', err?.message || err);
    return res.status(200).json({ success: false, data: [], hasMore: false, error: err?.message || 'Failed' });
  }
}
