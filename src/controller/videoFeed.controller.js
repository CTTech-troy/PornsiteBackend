/**
 * Paginated video feed via RapidAPI xnxx-api GET /xn/best?page=
 * GET /api/videos?page=1&limit=20 → { data: Video[], total, page, totalPages, hasMore }
 */
import { getFirebaseRtdb } from '../config/firebase.js';
import { lookupHomeFeedRow, ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import {
  isXnxxApiConfigured,
  fetchXnxxBestPage,
  homeCardToFeedVideoItem,
} from '../utils/xnxxRapidApi.js';
import { fetchPublishedHomeCards, fetchPublishedVideoById } from '../utils/platformPublicFeed.js';

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

function feedItemHasRenderableMedia(item) {
  if (!item) return false;
  const thumb = item.thumbnailUrl && String(item.thumbnailUrl).trim() !== '';
  const url = item.videoUrl && String(item.videoUrl).trim().startsWith('http');
  return thumb || url;
}

export async function getVideosPaginated(page = 1, limit = 20, options = {}) {
  const { viewerUid = null } = options;
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));

  let platformVideos = [];
  // Only inject platform videos on the first page
  if (pageNum === 1) {
    try {
      // 1. Fetch from Firebase RTDB
      let rtdbList = [];
      const rtdb = getFirebaseRtdb();
      if (rtdb) {
        const snap = await rtdb.ref('videos').once('value');
        const val = snap.val();
        rtdbList = !val ? [] : Object.entries(val)
          .map(([id, v]) => ({ ...v, id, videoId: id, source: 'rtdb' }))
          .filter((v) => v.isLive === true);
      }

      // 2. Fetch from Supabase tiktok_videos
      let supabaseList = [];
      if (isSupabaseConfigured() && supabase) {
        const { data, error } = await supabase
          .from('tiktok_videos')
          .select('*')
          .eq('status', 'published')
          .order('created_at', { ascending: false })
          .limit(10);

        if (!error && data) {
          supabaseList = data.map(v => ({
            id: v.video_id,
            videoId: v.video_id,
            userId: v.user_id,
            title: v.title,
            description: v.description,
            videoUrl: v.storage_url,
            thumbnailUrl: v.thumbnail_url,
            totalLikes: v.likes_count,
            totalComments: v.comments_count,
            createdAt: new Date(v.created_at).getTime(),
            isLive: true,
            source: 'supabase'
          }));
        }
      }
      platformVideos = [...rtdbList, ...supabaseList].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch (err) {
      console.warn('Failed to fetch platform videos for feed:', err.message);
    }
  }

  if (!isXnxxApiConfigured()) {
    return { data: platformVideos, total: platformVideos.length, page: pageNum, totalPages: 1, hasMore: false };
  }

  const { ok, items: cards } = await fetchXnxxBestPage(pageNum);
  if (!ok || !cards?.length) {
    return { data: platformVideos, total: platformVideos.length, page: pageNum, totalPages: 1, hasMore: false };
  }

  ingestHomeFeedVideos(cards);
  const mapped = cards.map((c, i) => homeCardToFeedVideoItem(c, i)).filter(Boolean);
  const withThumb = mapped.filter((item) => item.thumbnailUrl && String(item.thumbnailUrl).trim() !== '');
  mergeCache(withThumb);

  // Combine platform videos with external videos
  const combinedData = pageNum === 1 ? [...platformVideos, ...withThumb] : withThumb;
  const data = combinedData.slice(0, limitNum);
  const hasMore = withThumb.length >= PER_PAGE_HINT;

  const pagesForDb = Math.min(5, Math.max(1, Math.ceil(limitNum / 20)));
  const cards = await fetchPublishedHomeCards({ page: pageNum, pagesCount: pagesForDb, viewerUid });
  if (cards.length) ingestHomeFeedVideos(cards);
  let data = cards
    .map((c, i) => homeCardToFeedVideoItem(c, i))
    .filter(Boolean)
    .filter(feedItemHasRenderableMedia);

  if (data.length < limitNum && isXnxxApiConfigured()) {
    const { ok, items: xcards } = await fetchXnxxBestPage(pageNum);
    if (ok && xcards?.length) {
      ingestHomeFeedVideos(xcards);
      const seen = new Set(data.map((d) => String(d.id)));
      for (let i = 0; i < xcards.length && data.length < limitNum; i++) {
        const mapped = homeCardToFeedVideoItem(xcards[i], i);
        if (!mapped || !feedItemHasRenderableMedia(mapped)) continue;
        const k = String(mapped.id);
        if (seen.has(k)) continue;
        seen.add(k);
        data.push(mapped);
      }
    }
  }

  data = data.slice(0, limitNum);
  mergeCache(data);
  if (data.length === 0) {
    return { data: [], total: 0, page: pageNum, totalPages: 0, hasMore: false };
  }

  const hasMore = data.length >= limitNum || data.length >= PER_PAGE_HINT;
  return await withRtdbMerge({
    data,
    total: combinedData.length,
    page: pageNum,
    totalPages: hasMore ? pageNum + 1 : pageNum,
    hasMore,
  });
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

export async function getVideoById(id, options = {}) {
  const { viewerUid = null } = options;
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
    const rtdb = getFirebaseRtdb();
    if (rtdb) {
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
    } else {
      video.totalLikes = video.totalLikes ?? 0;
      video.totalComments = video.totalComments ?? 0;
    }
    return video;
  }

  let items = cache.items;
  const now = Date.now();
  if (isXnxxApiConfigured() && (items.length === 0 || now - cache.ts >= CACHE_TTL_MS)) {
    const { ok, items: cards } = await fetchXnxxBestPage(1);
    if (ok && cards?.length) {
      ingestHomeFeedVideos(cards);
      const mapped = cards.map((c, i) => homeCardToFeedVideoItem(c, i)).filter(Boolean);
      items = mapped.filter(feedItemHasRenderableMedia);
      mergeCache(items);
    }
  }

  items = cache.items.filter(feedItemHasRenderableMedia);
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

  if (!video) {
    video = await fetchPublishedVideoById(videoId, viewerUid);
  }

  if (!video) return null;

  const rtdbLate = getFirebaseRtdb();
  if (rtdbLate) {
    try {
      const ref = rtdbLate.ref('videos').child(videoId);
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
  } else {
    video.totalLikes = video.totalLikes ?? 0;
    video.totalComments = video.totalComments ?? 0;
  }
  return video;
}
