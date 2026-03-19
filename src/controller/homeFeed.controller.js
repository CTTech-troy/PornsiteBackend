/**
 * Home feed via pornhub-api-xnxx POST /api/search.
 * GET /api/videos/home-feed?page=1&q=hot&pages=3
 * Fetches multiple pages at once so the client can display many videos initially.
 */
import { xnxxSearch } from './xnxxSearchFallback.js';
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';

function parseDurationToSeconds(val) {
  if (val == null || val === '') return 0;
  const n = Number(val);
  if (!Number.isNaN(n) && n >= 0) return Math.floor(n);
  const s = String(val).trim();
  const parts = s.split(':').map(Number);
  if (parts.length === 2 && parts.every((p) => !Number.isNaN(p))) {
    const [m, sec] = parts;
    return Math.max(0, Math.floor(m) * 60 + Math.floor(sec));
  }
  if (parts.length === 3 && parts.every((p) => !Number.isNaN(p))) {
    const [h, m, sec] = parts;
    return Math.max(0, Math.floor(h) * 3600 + Math.floor(m) * 60 + Math.floor(sec));
  }
  return 0;
}

/** API may return duration as duration, length, runtime, or duration_formatted. */
function getDurationSeconds(v) {
  if (!v || typeof v !== 'object') return 0;
  const raw = v.duration ?? v.length ?? v.runtime ?? v.duration_formatted ?? v.duration_sec;
  const sec = parseDurationToSeconds(raw);
  if (sec > 0) return sec;
  return parseDurationToSeconds(v.duration) || Number(v.duration) || 0;
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return '0:00';
  const n = Math.floor(Number(seconds));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function mapToCard(v, index) {
  if (!v || typeof v !== 'object') return null;
  const title = v.title || v.title_clean || v.name || v.video_title || 'Video';
  const thumb =
    v.thumb ?? v.thumbnail ?? v.thumbnailUrl ?? v.poster ?? v.thumb_url ?? v.image ?? v.preview ?? v.default_thumb
    ?? (v.thumbs && (v.thumbs[0]?.src ?? v.thumbs[0])) ?? (v.thumbnails && (v.thumbnails[0]?.url ?? v.thumbnails[0])) ?? '';
  const thumbStr = typeof thumb === 'string' ? thumb : (thumb?.src ?? thumb?.url ?? thumb?.href ?? '');
  return {
    id: v.video_id ?? v.id ?? v.key ?? v.url ?? v.viewkey ?? `v-${index}-${Math.random().toString(36).slice(2)}`,
    title: String(title),
    channel: v.channel ?? v.uploader ?? v.creator ?? v.uploader_name ?? (v.pornstars && (Array.isArray(v.pornstars) ? v.pornstars[0] : v.pornstars)) ?? 'Creator',
    views: v.views ?? v.views_count ?? v.view_count ?? 0,
    thumbnail: thumbStr,
    duration: formatDuration(getDurationSeconds(v)),
    durationSeconds: getDurationSeconds(v),
    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(String(v.video_id || v.id || title)).slice(0, 50)}`,
    videoSrc: v.url ?? v.video_url ?? v.link ?? v.video_link ?? '',
    likes: v.rating ?? '0',
    comments: '0',
    time: v.time ?? v.added ?? v.upload_date ?? '',
    description: title ? `Watch ${title}.` : 'Watch this video.',
  };
}

const DEFAULT_QUERY = 'hot';
const MIN_PAGES = 1;
const MAX_PAGES = 5;
const PER_PAGE_ESTIMATE = 20;

/**
 * GET /api/videos/home-feed?page=1&q=hot&pages=3
 * page = starting page (1-based)
 * q = search query (default "hot")
 * pages = how many pages to fetch in one request (1-5, default 3 for lots of content)
 */
export async function getHomeFeed(req, res) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const q = String(req.query.q || DEFAULT_QUERY).trim() || DEFAULT_QUERY;
  const pagesCount = Math.min(MAX_PAGES, Math.max(MIN_PAGES, parseInt(req.query.pages, 10) || 3));

  const pageNumbers = Array.from({ length: pagesCount }, (_, i) => page + i);
  const results = await Promise.all(pageNumbers.map((p) => xnxxSearch(q, p)));

  const seenIds = new Set();
  const merged = [];
  for (const list of results) {
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const card = mapToCard(v, merged.length);
      if (!card) continue;
      if (!card.videoSrc || typeof card.videoSrc !== 'string' || !card.videoSrc.startsWith('http')) {
        console.warn('[Video API] Home-feed video missing or invalid video_url:', { id: card.id, index: merged.length });
      }
      const id = card.id;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      merged.push(card);
    }
  }

  const hasMore = merged.length >= PER_PAGE_ESTIMATE * pagesCount;
  const nextPage = page + pagesCount;
  console.log('Video API Response: home-feed', { page, q, count: merged.length, hasMore });

  ingestHomeFeedVideos(merged);

  return res.json({
    success: true,
    data: merged,
    hasMore,
    nextPage,
    page,
    q,
  });
}
