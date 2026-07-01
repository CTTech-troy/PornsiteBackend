/**
 * Trending / home feed: creator-published videos from Supabase first (all live public listings, including premium).
 * Optional RapidAPI xnxx pages are appended after for extra variety when configured.
 */
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import { fetchXnxxBestPage, isXnxxApiConfigured } from '../utils/xnxxRapidApi.js';
import { countPublishedPublicVideos, fetchPublishedHomeCards } from '../utils/platformPublicFeed.js';
import { filterHomeFeedVideos } from '../utils/videoPlaybackValidation.js';
import { loadExternalFeedConfig } from '../services/externalFeedConfig.service.js';
import { buildStructuredFeedLayout } from '../services/feedLayout.service.js';
import { encodeFeedCursor, decodeFeedCursor } from './videoFeed.controller.js';
import { getFeedPageSizeSetting, normalizeFeedPageSize } from '../services/platformSettings.service.js';

const MIN_PAGES = 1;
const MAX_PAGES = 5;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const HOME_FEED_COUNT_TIMEOUT_MS = Math.max(250, Number(process.env.HOME_FEED_COUNT_TIMEOUT_MS || 1200));
const HOME_FEED_LAYOUT_TIMEOUT_MS = Math.max(250, Number(process.env.HOME_FEED_LAYOUT_TIMEOUT_MS || 1200));
const HOME_FEED_EXTERNAL_TIMEOUT_MS = Math.max(500, Number(process.env.HOME_FEED_EXTERNAL_TIMEOUT_MS || 2500));
const HOME_FEED_CONFIG_TIMEOUT_MS = Math.max(250, Number(process.env.HOME_FEED_CONFIG_TIMEOUT_MS || 1000));
const HOME_FEED_SETTINGS_TIMEOUT_MS = Math.max(250, Number(process.env.HOME_FEED_SETTINGS_TIMEOUT_MS || 1000));

function withTimeout(promise, timeoutMs, fallback, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[homeFeed] ${label} timed out after ${timeoutMs}ms`);
        resolve(fallback);
      }, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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
  creators.forEach((card) => pushUnique(out, seen, card));
  defaults.forEach((card) => pushUnique(out, seen, card));

  return out;
}

/**
 * GET /api/videos/home-feed?page=1&pages=1&limit=10
 * page = starting page (1-based)
 * pages = how many /xn/best pages to merge (1-5, default 3)
 */
export async function getHomeFeed(req, res) {
  try {
    const feedConfig = await withTimeout(
      loadExternalFeedConfig(),
      HOME_FEED_CONFIG_TIMEOUT_MS,
      { enabled: false, pagesPerRequest: 1, mixCreatorsFirst: true, activeProvider: 'disabled' },
      'external feed config',
    );
    const cursorPage = decodeFeedCursor(req.query.cursor || null)?.page;
    const page = cursorPage || Math.max(1, parseInt(req.query.page, 10) || 1);
    const adminPageSize = await withTimeout(
      getFeedPageSizeSetting(DEFAULT_LIMIT),
      HOME_FEED_SETTINGS_TIMEOUT_MS,
      DEFAULT_LIMIT,
      'feed page size setting',
    );
    const limit = req.query.limit == null
      ? adminPageSize
      : Math.min(MAX_LIMIT, normalizeFeedPageSize(parseInt(req.query.limit, 10), adminPageSize));
    const pagesFromQuery = parseInt(req.query.pages, 10);
    const pagesCount = Math.min(
      MAX_PAGES,
      Math.max(MIN_PAGES, Number.isFinite(pagesFromQuery) ? pagesFromQuery : feedConfig.pagesPerRequest || 1),
    );
    const category = String(req.query.category || '').trim();

    const [creatorCards, totalCount] = await Promise.all([
      fetchPublishedHomeCards({ page, pagesCount, viewerUid: req.uid || null, category, limit }),
      withTimeout(
        countPublishedPublicVideos({ category }),
        HOME_FEED_COUNT_TIMEOUT_MS,
        null,
        'public video count',
      ),
    ]);
    const defaultCards = [];
    const seenDefaultIds = new Set();

    if (!category && feedConfig.enabled && isXnxxApiConfigured()) {
      const pageNumbers = Array.from({ length: pagesCount }, (_, i) => page + i);
      for (const p of pageNumbers) {
        const { ok, items } = await withTimeout(
          fetchXnxxBestPage(p, { timeoutMs: HOME_FEED_EXTERNAL_TIMEOUT_MS }),
          HOME_FEED_EXTERNAL_TIMEOUT_MS,
          { ok: false, items: [] },
          `external feed page ${p}`,
        );
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
    const sliced = merged.slice(0, limit);
    ingestHomeFeedVideos(sliced);
    let feedLayout = { items: sliced.map((video, index) => ({ type: 'video', key: `video:${video?.id || index}`, video, index })), meta: { device: 'desktop', adSlots: [], rules: [] } };
    try {
      feedLayout = await withTimeout(
        buildStructuredFeedLayout({
          videos: sliced,
          req,
          pageKey: category ? 'category' : 'home',
          category,
          seed: `${page}:${pagesCount}:${category || 'home'}`,
        }),
        HOME_FEED_LAYOUT_TIMEOUT_MS,
        feedLayout,
        'structured feed layout',
      );
    } catch (layoutErr) {
      console.warn('[homeFeed] feed layout fallback:', layoutErr?.message || layoutErr);
    }

    const hasKnownTotal = Number.isFinite(Number(totalCount)) && Number(totalCount) > 0;
    const estimatedTotal = ((page - 1) * limit) + sliced.length + (sliced.length >= limit ? limit : 0);
    const total = hasKnownTotal ? Math.max(Number(totalCount), merged.length) : estimatedTotal;
    const totalPages = total > 0 ? Math.max(1, Math.ceil(total / limit)) : 0;
    const hasMore = totalPages > 0 ? page < totalPages : merged.length > limit;
    const nextPage = page + pagesCount;
    const nextCursor = hasMore ? encodeFeedCursor(nextPage) : null;

    console.log('Video API Response: home-feed', {
      page,
      pagesCount,
      count: sliced.length,
      pageSize: limit,
      totalCount: total,
      totalPages,
      structuredItems: feedLayout.items.length,
      adItems: feedLayout.items.filter((item) => item.type === 'ad').length,
      hasMore,
      creatorCount: creatorCards.length,
      defaultCount: defaultCards.length,
      limit,
      creatorFirst: true,
      category: category || undefined,
    });

    res.set('Cache-Control', req.uid ? 'private, max-age=15' : 'public, max-age=30, stale-while-revalidate=120');
    return res.json({
      success: true,
      items: sliced,
      data: sliced,
      feed: feedLayout.items,
      layout: feedLayout.items,
      adLayout: feedLayout.meta,
      hasMore,
      totalCount: total,
      total,
      totalPages,
      nextPage,
      nextCursor,
      page,
      pageSize: limit,
      limit,
      batchSize: sliced.length,
      q: feedConfig.enabled && defaultCards.length > 0 ? 'mixed' : 'creators',
      provider: feedConfig.activeProvider,
      category: category || null,
    });
  } catch (err) {
    console.error('[homeFeed] getHomeFeed error:', err?.message || err);
    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    return res.status(200).json({
      success: false,
      data: [],
      items: [],
      hasMore: false,
      totalCount: 0,
      total: 0,
      totalPages: 0,
      nextPage: Math.max(1, parseInt(req.query.page, 10) || 1) + 1,
      nextCursor: null,
      page: Math.max(1, parseInt(req.query.page, 10) || 1),
      pageSize: DEFAULT_LIMIT,
      limit: DEFAULT_LIMIT,
      recoverable: true,
      error: err?.message || 'Failed to load home feed',
    });
  }
}
