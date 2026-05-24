import { fetchXnxxTodaysSelection, isXnxxApiConfigured } from '../utils/xnxxRapidApi.js';
import { fetchPublishedHomeCards } from '../utils/platformPublicFeed.js';
import { filterHomeFeedVideos } from '../utils/videoPlaybackValidation.js';
import { loadExternalFeedConfig } from '../services/externalFeedConfig.service.js';
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';

export async function getTodaysSelection(req, res) {
  try {
    const creatorCards = await fetchPublishedHomeCards({ page: 1, pagesCount: 2, viewerUid: req.uid || null });
    const merged = [...creatorCards];
    const seen = new Set(merged.map((c) => String(c.id)));

    const feedConfig = await loadExternalFeedConfig();
    if (feedConfig.enabled && isXnxxApiConfigured()) {
      const { ok, items } = await fetchXnxxTodaysSelection();
      if (ok && items?.length) {
        for (const card of filterHomeFeedVideos(items)) {
          const id = String(card.id);
          if (seen.has(id)) continue;
          seen.add(id);
          merged.push(card);
        }
      }
    }

    const data = merged.slice(0, 40);
    ingestHomeFeedVideos(data);

    return res.json({
      success: true,
      data,
      hasMore: false,
    });
  } catch (err) {
    console.error('[todaysSelection] error:', err?.message || err);
    return res.status(200).json({ success: false, data: [], hasMore: false, error: err?.message || 'Failed' });
  }
}
