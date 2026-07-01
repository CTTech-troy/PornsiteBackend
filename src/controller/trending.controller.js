import { fetchXnxxBestPage, isXnxxApiConfigured } from '../utils/xnxxRapidApi.js';
import { fetchPublishedHomeCards } from '../utils/platformPublicFeed.js';
import { filterHomeFeedVideos } from '../utils/videoPlaybackValidation.js';
import { loadExternalFeedConfig } from '../services/externalFeedConfig.service.js';
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import { getFeedPageSizeSetting, normalizeFeedPageSize } from '../services/platformSettings.service.js';

function creatorPriorityRank(card = {}) {
  if (card.creatorPriority === true || card.userId || card.user_id || card.creatorId || card.creator_id) return 0;
  const source = String(card.source || card.contentSource || card.content_source || '').toLowerCase();
  if (['community', 'creator', 'rtdb', 'media', 'official_import'].includes(source)) return 0;
  if (card.officialCompanyContent === true || card.official_company_content === true) return 1;
  return 2;
}

export async function getTrending(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const adminPageSize = await getFeedPageSizeSetting(20);
    const limit = req.query.limit == null
      ? adminPageSize
      : normalizeFeedPageSize(parseInt(req.query.limit, 10), adminPageSize);
    const creatorCards = await fetchPublishedHomeCards({ page, pagesCount: 1, viewerUid: req.uid || null, limit });
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

    merged.sort((a, b) => {
      const priority = creatorPriorityRank(a) - creatorPriorityRank(b);
      if (priority !== 0) return priority;
      return Number(b.views || b.totalViews || 0) - Number(a.views || a.totalViews || 0);
    });
    const data = merged.slice(0, limit);
    ingestHomeFeedVideos(data);

    res.set('Cache-Control', req.uid ? 'private, max-age=15' : 'public, max-age=30, stale-while-revalidate=120');
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
