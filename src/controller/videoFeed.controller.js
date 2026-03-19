/**
 * Paginated video feed via RapidAPI xnxx-api GET /xn/best?page=
 * GET /api/videos?page=1&limit=20 → { data: Video[], total, page, totalPages, hasMore }
 */
import { rtdb } from '../config/firebase.js';
import { lookupHomeFeedRow, ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import {
  isXnxxApiConfigured,
  fetchXnxxBestPage,
  homeCardToFeedVideoItem,
} from '../utils/xnxxRapidApi.js';

const CACHE_MAX_ITEMS = 500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const PER_PAGE_HINT = 18;

let cache = { items: [], ts: 0 };

function mergeCache(items) {
  const seen = new Set();
  const merged = [];
  for (const it of cache.items) {
    if (!it?.id) continue;
    const k = String(it.id);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(it);
  }
  for (const it of items) {
    if (!it?.id) continue;
    const k = String(it.id);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(it);
  }
  cache = { items: merged.slice(0, CACHE_MAX_ITEMS), ts: Date.now() };
}

export async function getVideosPaginated(page = 1, limit = 20) {
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));

  if (!isXnxxApiConfigured()) {
    return { data: [], total: 0, page: pageNum, totalPages: 0, hasMore: false };
  }

  const { ok, items: cards } = await fetchXnxxBestPage(pageNum);
  if (!ok || !cards?.length) {
    return { data: [], total: 0, page: pageNum, totalPages: 0, hasMore: false };
  }

  ingestHomeFeedVideos(cards);
  const mapped = cards.map((c, i) => homeCardToFeedVideoItem(c, i)).filter(Boolean);
  const withThumb = mapped.filter((item) => item.thumbnailUrl && String(item.thumbnailUrl).trim() !== '');
  mergeCache(withThumb);
  const data = withThumb.slice(0, limitNum);
  const hasMore = withThumb.length >= PER_PAGE_HINT;
  return await withRtdbMerge({
    data,
    total: data.length,
    page: pageNum,
    totalPages: hasMore ? pageNum + 1 : pageNum,
    hasMore,
  });
}

async function withRtdbMerge(result) {
  const { data } = result;
  try {
    const rtdbRef = rtdb.ref('videos');
    await Promise.all(
      data.map(async (item) => {
        const ref = rtdbRef.child(String(item.id));
        const snap = await ref.once('value');
        let val = snap.val();
        if (!val) {
          await ref.set({ externalId: String(item.id), totalLikes: 0, totalComments: 0 });
          val = { totalLikes: 0, totalComments: 0 };
        }
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

export async function getVideoById(id) {
  const videoId = String(id || '').trim();
  if (!videoId) return null;

  const hf = lookupHomeFeedRow(videoId);
  if (hf) {
    const video = {
      id: String(hf.id),
      videoUrl: String(hf.videoSrc || hf.url || ''),
      thumbnailUrl: String(hf.thumbnail || ''),
      duration: Number(hf.durationSeconds) || 0,
      createdAt: new Date().toISOString(),
      title: hf.title || '',
      channel: hf.channel || '',
      views: hf.views ?? 0,
    };
    try {
      const ref = rtdb.ref('videos').child(videoId);
      const snap = await ref.once('value');
      const val = snap.val();
      if (!val) {
        await ref.set({ externalId: videoId, totalLikes: 0, totalComments: 0 });
        video.totalLikes = 0;
        video.totalComments = 0;
      } else {
        video.totalLikes = val.totalLikes ?? 0;
        video.totalComments = val.totalComments ?? 0;
      }
    } catch (err) {
      video.totalLikes = video.totalLikes ?? 0;
      video.totalComments = video.totalComments ?? 0;
    }
    return video;
  }

  if (!isXnxxApiConfigured()) return null;

  let items = cache.items;
  const now = Date.now();
  if (items.length === 0 || now - cache.ts >= CACHE_TTL_MS) {
    const { ok, items: cards } = await fetchXnxxBestPage(1);
    if (ok && cards?.length) {
      ingestHomeFeedVideos(cards);
      const mapped = cards.map((c, i) => homeCardToFeedVideoItem(c, i)).filter(Boolean);
      items = mapped.filter((item) => item.thumbnailUrl && String(item.thumbnailUrl).trim() !== '');
      mergeCache(items);
    }
  }

  items = cache.items.filter((item) => item.thumbnailUrl && String(item.thumbnailUrl).trim() !== '');
  let video = items.find((item) => String(item.id) === videoId);

  if (!video) {
    const hf2 = lookupHomeFeedRow(videoId);
    if (hf2) {
      video = {
        id: String(hf2.id),
        videoUrl: String(hf2.videoSrc || hf2.url || ''),
        thumbnailUrl: String(hf2.thumbnail || ''),
        duration: Number(hf2.durationSeconds) || 0,
        createdAt: new Date().toISOString(),
        title: hf2.title || '',
        channel: hf2.channel || '',
        views: hf2.views ?? 0,
      };
    }
  }

  if (!video) return null;

  try {
    const ref = rtdb.ref('videos').child(videoId);
    const snap = await ref.once('value');
    const val = snap.val();
    if (!val) {
      await ref.set({ externalId: videoId, totalLikes: 0, totalComments: 0 });
      video.totalLikes = 0;
      video.totalComments = 0;
    } else {
      video.totalLikes = val.totalLikes ?? 0;
      video.totalComments = val.totalComments ?? 0;
    }
  } catch (err) {
    video.totalLikes = video.totalLikes ?? 0;
    video.totalComments = video.totalComments ?? 0;
  }
  return video;
}
