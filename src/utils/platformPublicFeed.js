/**
 * Published TikTok-style videos from Supabase for guests when external xnxx feed is off or empty.
 */
import { supabase, isConfigured } from '../config/supabase.js';
import { mergeCreatorIntoPublicVideo } from './creatorProfile.js';

const CONSENT_QUESTION = 'Do you confirm you have permission to post this video?';

function applyPublicListingFilter(q) {
  return q.or('is_live.eq.true,status.eq.published');
}

function mapTiktokRowToPublicVideo(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    videoId: row.video_id,
    userId: row.user_id,
    title: row.title || '',
    description: row.description || '',
    mainOrientationCategory: row.main_orientation_category || '',
    category: row.main_orientation_category || '',
    tags: row.tags || [],
    allowPeopleToComment: row.allow_people_to_comment !== false,
    videoUrl: row.storage_url || row.stream_url || '',
    streamUrl: row.stream_url || row.storage_url || '',
    thumbnailUrl: row.thumbnail_url || null,
    durationSeconds: Number(row.duration || 0),
    creatorDisplayName: row.creator_display_name || null,
    creatorAvatarUrl: row.creator_avatar_url || null,
    consentQuestion: CONSENT_QUESTION,
    consentGiven: row.consent_given === true,
    isLive: row.is_live === true,
    isPremiumContent: row.is_premium_content === true,
    tokenPrice: Number(row.token_price || row.coin_price || 0),
    totalLikes: Number(row.likes_count || 0),
    totalComments: Number(row.comments_count || 0),
    totalViews: Number(row.views_count || 0),
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

function formatDuration(seconds) {
  const n = Math.floor(Number(seconds) || 0);
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Same shape as mapRawToHomeCard (xnxxRapidApi) for home-feed + VideoFeed.jsx */
export function publicVideoToHomeCard(v, index) {
  if (!v || typeof v !== 'object') return null;
  const id = v.videoId ?? v.id;
  if (!id) return null;
  const pageUrl = String(v.videoUrl || v.streamUrl || '').trim();
  const preview = String(v.previewVideo || '').trim();
  const thumb = String(v.thumbnailUrl || '').trim();
  const dur = Number(v.durationSeconds) || 0;
  const title = v.title || 'Video';
  const seed = String(v.userId || id || title).slice(0, 50);
  return {
    id: String(id),
    title: String(title),
    channel: String(v.creatorDisplayName || v.channel || 'Creator'),
    views: v.totalViews ?? v.views ?? 0,
    thumbnail: thumb,
    duration: formatDuration(dur),
    durationSeconds: dur,
    avatar: v.creatorAvatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seed)}`,
    videoSrc: preview || pageUrl,
    previewVideo: preview || undefined,
    likes: String(v.totalLikes ?? 0),
    comments: String(v.totalComments ?? 0),
    time: '',
    description: title ? `Watch ${title}.` : 'Watch this video.',
    isPremiumContent: v.isPremiumContent === true,
    tokenPrice: Number(v.tokenPrice) || 0,
  };
}

/** GET /api/videos (paginated) item shape — matches homeCardToFeedVideoItem output */
export function publicVideoToFeedItem(v, index) {
  if (!v || typeof v !== 'object') return null;
  const duration = Number(v.durationSeconds) || 0;
  const preview = String(v.previewVideo || '').trim();
  const page = String(v.videoUrl || v.streamUrl || '').trim();
  const id = v.videoId ?? v.id;
  if (!id) return null;
  return {
    id: String(id),
    videoUrl: preview || page,
    previewVideo: preview,
    thumbnailUrl: String(v.thumbnailUrl || ''),
    duration,
    createdAt: new Date().toISOString(),
    title: v.title || '',
    channel: v.creatorDisplayName || v.channel || '',
    views: v.totalViews ?? v.views ?? 0,
    isPremiumContent: v.isPremiumContent === true,
    tokenPrice: Number(v.tokenPrice) || 0,
  };
}

/**
 * @param {{ page: number, pagesCount: number }} opts page 1-based, pagesCount merged "pages" width
 * @returns {Promise<Array>} home-card shaped rows
 */
export async function fetchPublishedHomeCards({ page, pagesCount, viewerUid = null }) {
  if (!isConfigured() || !supabase) return [];
  const pageNum = Math.max(1, Number(page) || 1);
  const pages = Math.min(5, Math.max(1, Number(pagesCount) || 1));
  const pageSize = Math.min(200, 20 * pages);
  const from = (pageNum - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error } = await applyPublicListingFilter(
    supabase.from('tiktok_videos').select('*')
  )
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error || !Array.isArray(data) || data.length === 0) return [];
  const mapped = data.map(mapTiktokRowToPublicVideo).filter(Boolean);
  const enriched = await Promise.all(mapped.map((m) => mergeCreatorIntoPublicVideo(m)));
  return enriched.map((v, i) => publicVideoToHomeCard(v, i)).filter(Boolean);
}

/**
 * Paginated feed rows for GET /api/videos when xnxx is disabled.
 * @param {{ page: number, limit: number }} opts
 */
export async function fetchPublishedFeedPage({ page, limit, viewerUid = null }) {
  if (!isConfigured() || !supabase) return [];
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
  const from = (pageNum - 1) * limitNum;
  const to = from + limitNum - 1;
  const { data, error } = await applyPublicListingFilter(
    supabase.from('tiktok_videos').select('*')
  )
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error || !Array.isArray(data) || data.length === 0) return [];
  const mapped = data.map(mapTiktokRowToPublicVideo).filter(Boolean);
  const enriched = await Promise.all(mapped.map((m) => mergeCreatorIntoPublicVideo(m)));
  return enriched.map((v, i) => publicVideoToFeedItem(v, i)).filter(Boolean);
}

/**
 * Single published video for detail resolution when cache/xnxx miss.
 */
export async function fetchPublishedVideoById(videoId, viewerUid = null) {
  if (!isConfigured() || !supabase || !videoId) return null;
  const { data, error } = await applyPublicListingFilter(
    supabase.from('tiktok_videos').select('*').eq('video_id', String(videoId).trim())
  ).maybeSingle();
  if (error || !data) return null;
  const m = mapTiktokRowToPublicVideo(data);
  if (!m) return null;
  const v = await mergeCreatorIntoPublicVideo(m);
  const page = String(v.videoUrl || v.streamUrl || '').trim();
  const preview = String(v.previewVideo || '').trim();
  return {
    id: String(v.videoId),
    videoUrl: preview || page,
    thumbnailUrl: String(v.thumbnailUrl || ''),
    duration: Number(v.durationSeconds) || 0,
    createdAt: new Date().toISOString(),
    title: v.title || '',
    channel: v.creatorDisplayName || '',
    views: v.totalViews ?? 0,
    totalLikes: v.totalLikes ?? 0,
    totalComments: v.totalComments ?? 0,
  };
}
