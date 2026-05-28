/**
 * Public paginated video feed.
 * GET /api/videos?page=1&limit=10 -> { data, total, page, totalPages, hasMore, nextCursor }
 */
import { getFirebaseRtdb } from '../config/firebase.js';
import { lookupHomeFeedRow, ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import {
  isXnxxApiConfigured,
  fetchXnxxBestPage,
  homeCardToFeedVideoItem,
} from '../utils/xnxxRapidApi.js';
import { fetchPublishedHomeCards, fetchPublishedVideoById } from '../utils/platformPublicFeed.js';
import { annotatePlayableVideo, isDirectPlayableStreamUrl, isListableInHomeFeed, isPlayableVideo } from '../utils/videoPlaybackValidation.js';

const CACHE_MAX_ITEMS = 500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const PER_PAGE_HINT = 10;

let cache = { items: [], ts: 0 };

function mergeCache(items) {
  const seen = new Set();
  const merged = [];

  for (const it of items) {
    if (!it?.id) continue;
    const k = String(it.id);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(it);
  }

  for (const it of cache.items) {
    if (!it?.id) continue;
    const k = String(it.id);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(it);
  }

  cache = { items: merged.slice(0, CACHE_MAX_ITEMS), ts: Date.now() };
}

function feedItemHasRenderableMedia(item) {
  if (!item) return false;
  const title = item.title && String(item.title).trim() !== '';
  const thumb = item.thumbnailUrl && String(item.thumbnailUrl).trim() !== '';
  const url = (item.playbackUrl || item.streamUrl || item.videoUrl) && String(item.playbackUrl || item.streamUrl || item.videoUrl).trim() !== '';
  if (!item.id || !(thumb || url || title)) return false;
  if (isPlayableVideo(item)) return true;
  return isListableInHomeFeed({
    ...item,
    thumbnail: item.thumbnailUrl,
    videoUrl: item.videoUrl || item.streamUrl,
    source: item.source || 'external',
  });
}

function mapCachedHomeFeedRow(hf) {
  if (!hf) return null;
  const iframeEmbed = String(hf.iframeEmbed || hf.iframe_embed || '').trim();
  const playbackType = iframeEmbed
    ? 'external_embed'
    : String(hf.playbackType || hf.playback_type || 'internal').trim();
  const isExternalEmbed = playbackType.toLowerCase() === 'external_embed' || iframeEmbed.length > 0;
  const page = String(
    isExternalEmbed
      ? (hf.videoUrl || hf.video_url || hf.pageUrl || hf.page_url || hf.externalUrl || hf.external_url || hf.url || hf.videoSrc || '')
      : (hf.playbackUrl || hf.playback_url || hf.streamUrl || hf.stream_url || hf.videoUrl || hf.video_url || hf.videoSrc || hf.url || '')
  );
  const directCandidate = String(hf.playbackUrl || hf.playback_url || hf.streamUrl || hf.stream_url || hf.storageUrl || hf.storage_url || hf.file_url || hf.videoSrc || '').trim();
  const allowImportedDirectHost = String(hf.source || hf.contentSource || hf.content_source || hf.sourceType || hf.source_type || '').toLowerCase().includes('imported');
  const directPlayableUrl = isDirectPlayableStreamUrl(directCandidate, { allowUnapprovedDirectHost: allowImportedDirectHost }) ? directCandidate : '';
  const playableUrl = directPlayableUrl || (isExternalEmbed ? '' : page);
  const effectivePlaybackType = directPlayableUrl ? 'internal' : playbackType;
  const effectiveSourceType = directPlayableUrl ? 'imported_direct_stream' : (hf.sourceType || hf.source_type || (isExternalEmbed ? 'external_embed' : ''));
  return {
    id: String(hf.id),
    videoUrl: page,
    video_url: page,
    streamUrl: playableUrl,
    stream_url: playableUrl,
    playbackUrl: playableUrl,
    playback_url: playableUrl,
    iframeEmbed,
    iframe_embed: iframeEmbed,
    playbackType: effectivePlaybackType,
    playback_type: effectivePlaybackType,
    pageUrl: page,
    page_url: page,
    externalUrl: hf.externalUrl || hf.external_url || hf.pageUrl || hf.page_url || page,
    external_url: hf.externalUrl || hf.external_url || hf.pageUrl || hf.page_url || page,
    thumbnailUrl: String(hf.thumbnail || hf.thumbnailUrl || hf.thumbnail_url || ''),
    thumbnail_url: String(hf.thumbnail_url || hf.thumbnailUrl || hf.thumbnail || ''),
    thumbnail: String(hf.thumbnail || hf.thumbnailUrl || hf.thumbnail_url || ''),
    duration: Number(hf.durationSeconds) || 0,
    createdAt: new Date().toISOString(),
    title: hf.title || '',
    channel: hf.channel || '',
    creatorDisplayName: hf.creatorDisplayName || hf.channel || '',
    creatorAvatarUrl: hf.creatorAvatarUrl || hf.avatar || '',
    avatar: hf.avatar || hf.creatorAvatarUrl || '',
    views: hf.views ?? 0,
    totalViews: hf.totalViews ?? hf.views ?? 0,
    source: hf.source || 'external',
    userId: hf.userId || null,
    allowPeopleToComment: hf.allowPeopleToComment !== false,
    isPremiumContent: hf.isPremiumContent === true || hf.is_premium_content === true || Number(hf.tokenPrice || hf.token_price || 0) > 0,
    tokenPrice: Number(hf.tokenPrice || hf.token_price || hf.coinPrice || hf.coin_price || 0) || 0,
    category: hf.category || hf.mainOrientationCategory || '',
    mainOrientationCategory: hf.mainOrientationCategory || hf.category || '',
    tags: Array.isArray(hf.tags) ? hf.tags : [],
    playable: isExternalEmbed || hf.playable === true,
    sourceType: effectiveSourceType,
    source_type: effectiveSourceType,
    embedAllowed: hf.embedAllowed === true || hf.embed_allowed === true || isExternalEmbed,
    embed_allowed: hf.embedAllowed === true || hf.embed_allowed === true || isExternalEmbed,
    validationStatus: hf.validationStatus || hf.validation_status || (isExternalEmbed ? 'playable' : (hf.playable ? 'playable' : 'unsupported')),
    validation_status: hf.validationStatus || hf.validation_status || (isExternalEmbed ? 'playable' : (hf.playable ? 'playable' : 'unsupported')),
  };
}

function firstString(...values) {
  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean) || '';
}

function hasInlineEmbed(item = {}) {
  return Boolean(firstString(item.iframeEmbed, item.iframe_embed));
}

function isImportedOrExternalEmbedDetail(item = {}) {
  const source = firstString(
    item.source,
    item.contentSource,
    item.content_source,
    item.sourceType,
    item.source_type,
  ).toLowerCase();
  const playbackType = firstString(item.playbackType, item.playback_type).toLowerCase();
  return (
    source.includes('imported') ||
    source.includes('external_catalog') ||
    playbackType === 'external_embed' ||
    playbackType === 'external_redirect'
  );
}

function shouldHydrateDetailFromPublished(item = {}) {
  if (!item || hasInlineEmbed(item)) return false;
  if (!isImportedOrExternalEmbedDetail(item)) return false;
  const pageUrl = firstString(item.videoUrl, item.video_url, item.pageUrl, item.page_url, item.externalUrl, item.external_url, item.url);
  const direct = firstString(item.playbackUrl, item.playback_url, item.streamUrl, item.stream_url, item.storageUrl, item.storage_url, item.file_url, item.videoSrc);
  return Boolean(pageUrl) && !isDirectPlayableStreamUrl(direct, { allowUnapprovedDirectHost: true });
}

async function hydratePublishedDetail(video, videoId, viewerUid) {
  if (!shouldHydrateDetailFromPublished(video)) return video;
  try {
    const published = await fetchPublishedVideoById(videoId, viewerUid);
    const hydrated = published ? annotatePlayableVideo(published) : null;
    if (feedItemHasRenderableMedia(hydrated) && (hasInlineEmbed(hydrated) || !hasInlineEmbed(video))) {
      return hydrated;
    }
  } catch (err) {
    console.warn('videoFeed detail hydration:', err?.message || err);
  }
  return video;
}

export function encodeFeedCursor(page) {
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  return Buffer.from(JSON.stringify({ page: pageNum }), 'utf8').toString('base64url');
}

export function decodeFeedCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const pageNum = Math.max(1, parseInt(String(parsed?.page), 10) || 1);
    return { page: pageNum };
  } catch {
    return null;
  }
}

export async function getVideosPaginated(page = 1, limit = DEFAULT_LIMIT, options = {}) {
  const { viewerUid = null, cursor = null, category = null } = options;
  const cursorPage = decodeFeedCursor(cursor)?.page;
  const pageNum = cursorPage || Math.max(1, parseInt(String(page), 10) || 1);
  const limitNum = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(limit), 10) || DEFAULT_LIMIT));
  const pagesForDb = Math.min(5, Math.max(1, Math.ceil(limitNum / 20)));
  const data = [];
  const seen = new Set();

  const addItem = (item) => {
    const playable = annotatePlayableVideo(item);
    if (!feedItemHasRenderableMedia(playable)) return;
    const key = String(playable.id);
    if (seen.has(key)) return;
    seen.add(key);
    data.push(playable);
  };

  try {
    const cards = await fetchPublishedHomeCards({ page: pageNum, pagesCount: pagesForDb, viewerUid, category });
    if (cards.length) ingestHomeFeedVideos(cards);
    cards.forEach((card, index) => addItem(homeCardToFeedVideoItem(card, index)));
  } catch (err) {
    console.warn('videoFeed platform feed:', err?.message || err);
  }

  if (data.length < limitNum && isXnxxApiConfigured()) {
    try {
      const { ok, items: cards } = await fetchXnxxBestPage(pageNum);
      if (ok && cards?.length) {
        ingestHomeFeedVideos(cards);
        cards.forEach((card, index) => {
          if (data.length < limitNum) addItem(homeCardToFeedVideoItem(card, index));
        });
      }
    } catch (err) {
      console.warn('videoFeed external feed:', err?.message || err);
    }
  }

  const sliced = data.slice(0, limitNum);
  mergeCache(sliced);

  if (sliced.length === 0) {
    return {
      data: [],
      total: 0,
      page: pageNum,
      totalPages: 0,
      hasMore: false,
      nextCursor: null,
      limit: limitNum,
      batchSize: 0,
    };
  }

  const hasMore = sliced.length >= limitNum || sliced.length >= PER_PAGE_HINT;
  return await withRtdbMerge({
    data: sliced,
    total: sliced.length,
    page: pageNum,
    totalPages: hasMore ? pageNum + 1 : pageNum,
    hasMore,
    nextCursor: hasMore ? encodeFeedCursor(pageNum + 1) : null,
    limit: limitNum,
    batchSize: sliced.length,
  });
}

export async function getLatestVideos(req, res) {
  const page = req.query.page || 1;
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
  try {
    const result = await getVideosPaginated(page, limit, {
      viewerUid: req.uid || null,
      cursor: req.query.cursor || null,
    });
    res.set('Cache-Control', req.uid ? 'private, max-age=15' : 'public, max-age=20, stale-while-revalidate=60');
    return res.json(result);
  } catch (err) {
    console.error('videos latest feed error', err?.message || err);
    res.set('X-API-Fallback', 'videos-latest-feed');
    return res.status(200).json({
      data: [],
      total: 0,
      page: Math.max(1, parseInt(req.query.page, 10) || 1),
      totalPages: 0,
      hasMore: false,
      nextCursor: null,
      recoverable: true,
      requestId: req.requestId,
    });
  }
}

export async function getCategoryVideos(req, res) {
  const page = req.query.page || 1;
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
  const category = String(req.params.slug || req.query.category || '').trim();
  try {
    const result = await getVideosPaginated(page, limit, {
      viewerUid: req.uid || null,
      cursor: req.query.cursor || null,
      category,
    });
    res.set('Cache-Control', req.uid ? 'private, max-age=15' : 'public, max-age=20, stale-while-revalidate=60');
    return res.json({ ...result, category: category || null });
  } catch (err) {
    console.error('videos category feed error', err?.message || err);
    res.set('X-API-Fallback', 'videos-category-feed');
    return res.status(200).json({
      data: [],
      total: 0,
      page: Math.max(1, parseInt(req.query.page, 10) || 1),
      totalPages: 0,
      hasMore: false,
      nextCursor: null,
      category: category || null,
      recoverable: true,
      requestId: req.requestId,
    });
  }
}

async function withRtdbMerge(result) {
  const { data } = result;
  const rtdb = getFirebaseRtdb();
  if (!rtdb) {
    data.forEach((item) => {
      item.totalLikes = item.totalLikes ?? 0;
      item.totalComments = item.totalComments ?? 0;
    });
    return result;
  }

  try {
    const rtdbRef = rtdb.ref('videos');
    await Promise.all(
      data.map(async (item) => {
        const ref = rtdbRef.child(String(item.id));
        const snap = await ref.once('value');
        const val = snap.val() || {};
        item.totalLikes = val.totalLikes ?? 0;
        item.totalComments = val.totalComments ?? 0;
        return item;
      })
    );
  } catch (err) {
    console.warn('videoFeed RTDB merge:', err?.message || err);
    data.forEach((item) => {
      item.totalLikes = item.totalLikes ?? 0;
      item.totalComments = item.totalComments ?? 0;
    });
  }
  return result;
}

export async function getVideoById(id, options = {}) {
  const { viewerUid = null } = options;
  const videoId = String(id || '').trim();
  if (!videoId) return null;

  const cachedHomeFeedRow = lookupHomeFeedRow(videoId);
  if (cachedHomeFeedRow) {
    let video = annotatePlayableVideo(mapCachedHomeFeedRow(cachedHomeFeedRow));
    if (!feedItemHasRenderableMedia(video)) return null;
    video = await hydratePublishedDetail(video, videoId, viewerUid);
    return await withRtdbMerge({ data: [video] }).then((result) => result.data[0]);
  }

  let items = cache.items;
  const now = Date.now();
  if (isXnxxApiConfigured() && (items.length === 0 || now - cache.ts >= CACHE_TTL_MS)) {
    try {
      const { ok, items: cards } = await fetchXnxxBestPage(1);
      if (ok && cards?.length) {
        ingestHomeFeedVideos(cards);
        const mapped = cards.map((card, index) => homeCardToFeedVideoItem(card, index)).filter(feedItemHasRenderableMedia);
        mergeCache(mapped);
        items = mapped;
      }
    } catch (err) {
      console.warn('videoFeed refresh cache:', err?.message || err);
    }
  }

  items = cache.items.map(annotatePlayableVideo).filter(feedItemHasRenderableMedia);
  let video = items.find((item) => String(item.id) === videoId);

  if (!video) {
    video = annotatePlayableVideo(mapCachedHomeFeedRow(lookupHomeFeedRow(videoId)));
    if (!feedItemHasRenderableMedia(video)) video = null;
  }

  if (video) {
    video = await hydratePublishedDetail(video, videoId, viewerUid);
  }

  if (!video) {
    const published = await fetchPublishedVideoById(videoId, viewerUid);
    video = published ? annotatePlayableVideo(published) : null;
    if (!feedItemHasRenderableMedia(video)) video = null;
  }

  if (!video) return null;

  const result = await withRtdbMerge({ data: [video] });
  return result.data[0];
}
