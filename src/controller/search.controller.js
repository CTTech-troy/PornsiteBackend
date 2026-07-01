import { fetchXnxxSearch } from '../utils/xnxxRapidApi.js';
import { loadExternalFeedConfig } from '../services/externalFeedConfig.service.js';
import { filterHomeFeedVideos } from '../utils/videoPlaybackValidation.js';
import {
  autocompleteSearch,
  getSearchPublicConfig,
  getTrendingSearchQueries,
  searchAllContent,
  searchPlatformVideos,
  suggestSearchQueries,
} from '../services/searchIndex.service.js';
import { fetchPublishedHomeCards } from '../utils/platformPublicFeed.js';
import { getFeedPageSizeSetting, normalizeFeedPageSize } from '../services/platformSettings.service.js';

export async function searchVideos(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const adminPageSize = await getFeedPageSizeSetting(20);
    const limit = req.query.limit == null
      ? adminPageSize
      : Math.min(500, normalizeFeedPageSize(parseInt(req.query.limit, 10), adminPageSize));
    const contentSource = req.query.source || null;
    const premium = req.query.premium === 'true';

    if (!q) {
      const cards = await fetchPublishedHomeCards({ page, pagesCount: 1, viewerUid: req.uid || null, limit });
      return res.json({
        success: true,
        data: cards,
        hasMore: cards.length >= limit,
        page,
        total: cards.length,
        totalPages: cards.length ? Math.ceil(cards.length / limit) : 0,
      });
    }

    const platform = await searchPlatformVideos(q, {
      page,
      limit,
      userId: req.uid || null,
      filters: { contentSource, premium },
    });

    let merged = [...(platform.items || [])];
    const feedConfig = await loadExternalFeedConfig();
    if (merged.length < limit && feedConfig.enabled) {
      try {
        const { ok, items } = await fetchXnxxSearch(q, page);
        if (ok && items?.length) {
          const ext = filterHomeFeedVideos(items);
          const seen = new Set(merged.map((v) => String(v.id)));
          for (const item of ext) {
            const id = String(item.id);
            if (seen.has(id)) continue;
            seen.add(id);
            merged.push(item);
            if (merged.length >= limit) break;
          }
        }
      } catch (err) {
        console.warn('[search] external fallback:', err?.message || err);
      }
    }

    res.set('Cache-Control', req.uid ? 'private, max-age=15' : 'public, max-age=30, stale-while-revalidate=120');
    return res.json({
      success: true,
      data: merged.slice(0, limit),
      hasMore: platform.hasMore || merged.length >= limit,
      page,
      total: platform.total,
      totalPages: platform.total ? Math.ceil(platform.total / limit) : 0,
    });
  } catch (err) {
    console.error('[search] searchVideos error:', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Search failed', data: [] });
  }
}

export async function searchSuggest(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    const suggestions = q ? await suggestSearchQueries(q, 8) : await getTrendingSearchQueries(8);
    return res.json({ success: true, data: suggestions });
  } catch (err) {
    return res.status(500).json({ success: false, data: [], error: err?.message || 'Failed' });
  }
}

export async function searchAutocomplete(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(12, Math.max(1, parseInt(req.query.limit, 10) || 8));
    const data = await autocompleteSearch(q, limit);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, data: [], error: err?.message || 'Autocomplete failed' });
  }
}

export async function globalSearch(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 6));
    if (!q) return res.json({ success: true, data: { videos: [], creators: [], liveStreams: [], tags: [], categories: [] } });
    const data = await searchAllContent(q, { limit, includeUsers: false });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, data: {}, error: err?.message || 'Search failed' });
  }
}

export async function searchConfig(req, res) {
  return res.json({ success: true, data: getSearchPublicConfig() });
}

export async function searchTrendingQueries(req, res) {
  try {
    const data = await getTrendingSearchQueries(12);
    return res.json({ success: true, data });
  } catch (err) {
    console.warn('[search] trending queries fallback:', err?.message || err);
    res.set('X-API-Fallback', 'search-trending-queries');
    return res.status(200).json({
      success: false,
      data: [],
      recoverable: true,
      requestId: req.requestId,
    });
  }
}

export async function searchPornstars(req, res) {
  return res.json({ success: true, data: [] });
}
