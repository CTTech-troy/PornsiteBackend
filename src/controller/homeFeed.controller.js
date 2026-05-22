/**
 * Trending / home feed: creator-published videos from Supabase first (all live public listings, including premium).
 * Optional RapidAPI xnxx pages are appended after for extra variety when configured.
 */
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import { fetchXnxxBestPage, isXnxxApiConfigured } from '../utils/xnxxRapidApi.js';
import { fetchPublishedHomeCards } from '../utils/platformPublicFeed.js';
import { filterHomeFeedVideos } from '../utils/videoPlaybackValidation.js';
import { loadExternalFeedConfig } from '../services/externalFeedConfig.service.js';

const MIN_PAGES = 1;
const MAX_PAGES = 5;

function pushUnique(out, seenIds, card) {
  if (!card) return;
  const id = card.id != null ? String(card.id) : '';
  if (!id || seenIds.has(id)) return;
  seenIds.add(id);
  out.push(card);
}

function interleaveCreatorCards(creatorCards, defaultCards) {
  const creators = Array.isArray(creatorCards) ? creatorCards : [];
  const defaults = Array.isArray(defaultCards) ? defaultCards : [];
  if (!creators.length) return defaults;
  if (!defaults.length) return creators;

  const out = [];
  const seen = new Set();
  const gap = Math.max(2, Math.floor(defaults.length / (creators.length + 1)) || 2);
  let creatorIndex = 0;

  for (let i = 0; i < defaults.length; i += 1) {
    pushUnique(out, seen, defaults[i]);
    const shouldInsertCreator =
      creatorIndex < creators.length &&
      ((i + 1) % gap === 0 || i === defaults.length - 1);
    if (shouldInsertCreator) {
      pushUnique(out, seen, creators[creatorIndex]);
      creatorIndex += 1;
    }
  }

  while (creatorIndex < creators.length) {
    pushUnique(out, seen, creators[creatorIndex]);
    creatorIndex += 1;
  }

  return out;
}

/**
 * GET /api/videos/home-feed?page=1&pages=3
 * page = starting page (1-based)
 * pages = how many /xn/best pages to merge (1-5, default 3)
 */
export async function getHomeFeed(req, res) {
  try {
    const feedConfig = await loadExternalFeedConfig();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pagesFromQuery = parseInt(req.query.pages, 10);
    const pagesCount = Math.min(
      MAX_PAGES,
      Math.max(MIN_PAGES, Number.isFinite(pagesFromQuery) ? pagesFromQuery : feedConfig.pagesPerRequest || 1),
    );

    const creatorCards = await fetchPublishedHomeCards({ page, pagesCount, viewerUid: req.uid || null });
    const defaultCards = [];
    const seenDefaultIds = new Set();

    if (feedConfig.enabled && isXnxxApiConfigured()) {
      const pageNumbers = Array.from({ length: pagesCount }, (_, i) => page + i);
      for (const p of pageNumbers) {
        const { ok, items } = await fetchXnxxBestPage(p);
        if (!ok || !items?.length) continue;
        for (let i = 0; i < items.length; i++) {
          const card = items[i];
          if (!card) continue;
          const extId = card.id != null ? String(card.id) : '';
          if (!extId || seenDefaultIds.has(extId)) continue;
          seenDefaultIds.add(extId);
          const listableCard = filterHomeFeedVideos([card])[0];
          if (listableCard) defaultCards.push(listableCard);
        }
      }
    }

    const merged = filterHomeFeedVideos(
      feedConfig.mixCreatorsFirst === false
        ? [...creatorCards, ...defaultCards]
        : interleaveCreatorCards(creatorCards, defaultCards),
    );
    ingestHomeFeedVideos(merged);

    const expectedPageSize = Math.min(200, 20 * pagesCount);
    const hasMore = merged.length >= expectedPageSize;
    const nextPage = page + pagesCount;

    console.log('Video API Response: home-feed', {
      page,
      pagesCount,
      count: merged.length,
      hasMore,
      creatorCount: creatorCards.length,
      defaultCount: defaultCards.length,
      interleaved: true,
    });

    return res.json({
      success: true,
      data: merged,
      hasMore,
      nextPage,
      page,
      q: feedConfig.enabled && defaultCards.length > 0 ? 'mixed' : 'creators',
      provider: feedConfig.activeProvider,
    });
  } catch (err) {
    console.error('[homeFeed] getHomeFeed error:', err?.message || err);
    return res.status(200).json({
      success: false,
      data: [],
      hasMore: false,
      nextPage: Math.max(1, parseInt(req.query.page, 10) || 1) + 1,
      page: Math.max(1, parseInt(req.query.page, 10) || 1),
      recoverable: true,
      error: err?.message || 'Failed to load home feed',
    });
  }
}
