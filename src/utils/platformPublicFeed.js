/**
 * Published TikTok-style videos from Supabase for guests when external xnxx feed is off or empty.
 */
import { supabase, isConfigured } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';
import { mergeCreatorIntoPublicVideo } from './creatorProfile.js';
import { getPathSafeVideoId } from './videoPathId.js';
import { annotatePlayableVideo, isPlayableVideo } from './videoPlaybackValidation.js';

const CONSENT_QUESTION = 'Do you confirm you have permission to post this video?';
const LEGACY_MEDIA_PREFIX = 'media-';

function applyPublicListingFilter(q) {
  return q.or('is_live.eq.true,status.eq.published');
}

function isMissingColumnError(err, columnName) {
  const msg = String(err?.message || '');
  return (
    err?.code === 'PGRST204' ||
    err?.code === '42703' ||
    (columnName && msg.includes(`'${columnName}'`)) ||
    /schema cache|Could not find the .* column/i.test(msg)
  );
}

function isMissingTableError(err) {
  const msg = String(err?.message || '');
  return (
    err?.code === '42P01' ||
    err?.code === 'PGRST200' ||
    /schema cache|Could not find the table|does not exist/i.test(msg)
  );
}

function toTimestamp(value) {
  if (value == null || value === '') return Date.now();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 9999999999 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function looksLikeVideoUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url)) return false;
  return (
    /\.(mp4|m4v|mov|webm|m3u8)(\?|#|$)/i.test(url) ||
    /\/(video|videos|stream|storage\/v1\/object\/public\/videos?)\//i.test(url)
  );
}

function getPrimaryVideoUrl(row = {}) {
  return String(
    row.videoUrl ||
    row.video_url ||
    row.streamUrl ||
    row.stream_url ||
    row.storage_url ||
    row.url ||
    row.publicUrl ||
    row.public_url ||
    ''
  ).trim();
}

function getPrimaryThumbnailUrl(row = {}) {
  return String(
    row.thumbnailUrl ||
    row.thumbnail_url ||
    row.thumbnail ||
    row.posterUrl ||
    row.poster_url ||
    row.poster ||
    ''
  ).trim();
}

function hasRenderablePublicVideo(v) {
  if (!v || typeof v !== 'object') return false;
  const title = String(v.title || '').trim();
  const thumb = String(v.thumbnailUrl || '').trim();
  const url = String(v.videoUrl || v.streamUrl || '').trim();
  return Boolean(v.id || v.videoId) && Boolean(title || thumb || url) && isPlayableVideo(v);
}

function isPublicLegacyRow(row = {}) {
  const status = String(row.status || row.visibility || '').trim().toLowerCase();
  if (['draft', 'private', 'removed', 'deleted', 'blocked', 'rejected'].includes(status)) return false;
  if (row.isLive === false || row.is_live === false || row.public === false) return false;
  return true;
}

function isVideoMediaRow(row = {}) {
  const type = String(row.type || row.media_type || row.content_type || row.mime_type || '').toLowerCase();
  const bucket = String(row.bucket || '').toLowerCase();
  const url = getPrimaryVideoUrl(row);
  if (type.includes('image') || type.includes('application_attachment')) return false;
  return type.includes('video') || bucket.includes('video') || looksLikeVideoUrl(url);
}

function mediaPublicId(rawId) {
  const raw = String(rawId || '').trim();
  if (!raw) return '';
  return raw.startsWith(LEGACY_MEDIA_PREFIX) ? raw : `${LEGACY_MEDIA_PREFIX}${raw}`;
}

async function runPublicListingQuery(buildQuery) {
  let result = await buildQuery((query) => applyPublicListingFilter(query));
  if (result.error && isMissingColumnError(result.error, 'status')) {
    result = await buildQuery((query) => query.eq('is_live', true));
  }
  return result;
}

function mapTiktokRowToPublicVideo(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.video_id,
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
    durationSeconds: Number(row.duration_seconds ?? row.duration ?? 0),
    creatorDisplayName: row.creator_display_name || null,
    creatorAvatarUrl: row.creator_avatar_url || null,
    consentQuestion: CONSENT_QUESTION,
    consentGiven: row.consent_given === true,
    isLive: row.is_live === true,
    isPremiumContent: row.is_premium_content === true,
    tokenPrice: Number(row.token_price || row.coin_price || 0),
    accessType: row.access_type || (row.is_premium_content === true ? 'premium' : 'free'),
    premiumVisibility: row.premium_visibility || null,
    requiresMembership: row.requires_membership === true,
    subscriptionAccess: row.subscription_access === true,
    officialCompanyContent: row.official_company_content === true,
    totalLikes: Number(row.likes_count || 0),
    totalComments: Number(row.comments_count || 0),
    totalViews: Number(row.views_count || 0),
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    source: row.content_source || (row.official_company_content === true ? 'imported' : 'community'),
    contentSource: row.content_source || null,
  };
}

function mapRtdbVideoRowToPublicVideo(videoId, row) {
  if (!row || typeof row !== 'object' || !isPublicLegacyRow(row)) return null;
  const id = String(row.videoId || row.video_id || videoId || row.id || '').trim();
  if (!id) return null;
  const videoUrl = getPrimaryVideoUrl(row);
  const thumbnailUrl = getPrimaryThumbnailUrl(row);
  return {
    id,
    videoId: id,
    userId: row.userId || row.user_id || row.uid || null,
    title: row.title || row.name || 'Video',
    description: row.description || '',
    mainOrientationCategory: row.mainOrientationCategory || row.main_orientation_category || row.category || '',
    category: row.category || row.mainOrientationCategory || row.main_orientation_category || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    allowPeopleToComment: row.allowPeopleToComment !== false,
    videoUrl,
    streamUrl: row.streamUrl || row.stream_url || videoUrl,
    thumbnailUrl: thumbnailUrl || null,
    durationSeconds: Number(row.durationSeconds ?? row.duration_seconds ?? row.duration ?? 0) || 0,
    creatorDisplayName: row.creatorDisplayName || row.creator_display_name || row.channel || null,
    creatorAvatarUrl: row.creatorAvatarUrl || row.creator_avatar_url || row.avatar || null,
    consentQuestion: row.consentQuestion || CONSENT_QUESTION,
    consentGiven: row.consentGiven !== false,
    isLive: row.isLive !== false,
    isPremiumContent: row.isPremiumContent === true || Number(row.tokenPrice || row.coin_price || 0) > 0,
    tokenPrice: Number(row.tokenPrice || row.coin_price || 0),
    accessType: row.accessType || row.access_type || (row.isPremiumContent ? 'premium' : 'free'),
    premiumVisibility: row.premiumVisibility || row.premium_visibility || null,
    requiresMembership: row.requiresMembership === true || row.requires_membership === true,
    subscriptionAccess: row.subscriptionAccess === true || row.subscription_access === true,
    totalLikes: Number(row.totalLikes || row.likes_count || 0),
    totalComments: Number(row.totalComments || row.comments_count || 0),
    totalViews: Number(row.totalViews ?? row.views ?? row.views_count ?? 0) || 0,
    createdAt: toTimestamp(row.createdAt || row.created_at || row.updatedAt || row.updated_at),
    source: 'rtdb',
  };
}

function mapMediaRowToPublicVideo(row, source = 'media') {
  if (!row || typeof row !== 'object' || !isPublicLegacyRow(row) || !isVideoMediaRow(row)) return null;
  const rawId = row.id || row.media_id || row.path || getPrimaryVideoUrl(row);
  const id = mediaPublicId(rawId);
  if (!id) return null;
  const videoUrl = getPrimaryVideoUrl(row);
  const thumbnailUrl = getPrimaryThumbnailUrl(row);
  return {
    id,
    videoId: id,
    userId: row.user_id || row.userId || row.uid || null,
    title: row.title || row.name || 'Creator video',
    description: row.description || '',
    mainOrientationCategory: row.main_orientation_category || row.mainOrientationCategory || row.category || '',
    category: row.category || row.main_orientation_category || row.mainOrientationCategory || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    allowPeopleToComment: false,
    videoUrl,
    streamUrl: videoUrl,
    thumbnailUrl: thumbnailUrl || null,
    durationSeconds: Number(row.duration_seconds ?? row.durationSeconds ?? row.duration ?? 0) || 0,
    creatorDisplayName: row.creator_display_name || row.creatorDisplayName || row.channel || null,
    creatorAvatarUrl: row.creator_avatar_url || row.creatorAvatarUrl || row.avatar || null,
    consentQuestion: CONSENT_QUESTION,
    consentGiven: true,
    isLive: true,
    isPremiumContent: row.is_premium_content === true || row.isPremiumContent === true || Number(row.token_price || row.tokenPrice || 0) > 0,
    tokenPrice: Number(row.token_price || row.tokenPrice || 0),
    accessType: row.access_type || row.accessType || (row.is_premium_content === true || row.isPremiumContent === true ? 'premium' : 'free'),
    premiumVisibility: row.premium_visibility || row.premiumVisibility || null,
    requiresMembership: row.requires_membership === true || row.requiresMembership === true,
    subscriptionAccess: row.subscription_access === true || row.subscriptionAccess === true,
    totalLikes: Number(row.likes_count || row.totalLikes || 0),
    totalComments: Number(row.comments_count || row.totalComments || 0),
    totalViews: Number(row.views_count ?? row.totalViews ?? row.views ?? 0) || 0,
    createdAt: toTimestamp(row.created_at || row.createdAt || row.updated_at || row.updatedAt),
    source,
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
  const pageUrl = String(v.playbackUrl || v.streamUrl || v.videoUrl || '').trim();
  const preview = String(v.previewVideo || '').trim();
  const thumb = String(v.thumbnailUrl || '').trim();
  const dur = Number(v.durationSeconds) || 0;
  const title = v.title || 'Video';
  const seed = String(v.userId || id || title).slice(0, 50);
  const accessType = String(v.accessType || v.access_type || '').trim().toLowerCase().replace(/-/g, '_')
    || (v.isPremiumContent === true || Number(v.tokenPrice || 0) > 0 ? 'premium' : 'free');
  const requiresMembership = v.requiresMembership === true || v.requires_membership === true || accessType === 'members_only';
  const subscriptionAccess = v.subscriptionAccess === true || v.subscription_access === true || accessType === 'members_only';
  const isPremiumContent =
    v.isPremiumContent === true ||
    Number(v.tokenPrice || 0) > 0 ||
    ['premium', 'members_only', 'coin_unlock'].includes(accessType) ||
    requiresMembership ||
    subscriptionAccess;
  return {
    id: String(id),
    title: String(title),
    channel: String(v.creatorDisplayName || v.channel || 'Creator'),
    views: v.totalViews ?? v.views ?? 0,
    thumbnail: thumb,
    duration: formatDuration(dur),
    durationSeconds: dur,
    avatar: v.creatorAvatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seed)}`,
    creatorDisplayName: v.creatorDisplayName || v.channel || 'Creator',
    creatorAvatarUrl: v.creatorAvatarUrl || null,
    videoSrc: preview || pageUrl,
    videoUrl: pageUrl,
    streamUrl: pageUrl,
    playbackUrl: pageUrl,
    playback_url: pageUrl,
    previewVideo: preview || undefined,
    likes: String(v.totalLikes ?? 0),
    comments: String(v.totalComments ?? 0),
    time: '',
    description: title ? `Watch ${title}.` : 'Watch this video.',
    source: v.source || 'community',
    contentSource: v.contentSource || v.content_source || null,
    userId: v.userId || null,
    allowPeopleToComment: v.allowPeopleToComment !== false,
    category: v.category || v.mainOrientationCategory || '',
    mainOrientationCategory: v.mainOrientationCategory || v.category || '',
    tags: Array.isArray(v.tags) ? v.tags : [],
    totalViews: v.totalViews ?? v.views ?? 0,
    isPremiumContent,
    tokenPrice: Number(v.tokenPrice) || 0,
    accessType,
    access_type: accessType,
    premiumVisibility: v.premiumVisibility || v.premium_visibility || (accessType === 'free' ? 'public' : 'public_preview'),
    premium_visibility: v.premiumVisibility || v.premium_visibility || (accessType === 'free' ? 'public' : 'public_preview'),
    requiresMembership,
    requires_membership: requiresMembership,
    subscriptionAccess,
    subscription_access: subscriptionAccess,
    officialCompanyContent: v.officialCompanyContent === true || v.official_company_content === true,
    official_company_content: v.officialCompanyContent === true || v.official_company_content === true,
    playable: v.playable !== false,
    sourceType: v.sourceType || v.source_type || 'approved_stream',
    embedAllowed: v.embedAllowed === true || v.embed_allowed === true,
    validationStatus: v.validationStatus || v.validation_status || 'playable',
  };
}

/** GET /api/videos (paginated) item shape — matches homeCardToFeedVideoItem output */
export function publicVideoToFeedItem(v, index) {
  if (!v || typeof v !== 'object') return null;
  const duration = Number(v.durationSeconds) || 0;
  const preview = String(v.previewVideo || '').trim();
  const page = String(v.playbackUrl || v.streamUrl || v.videoUrl || '').trim();
  const id = v.videoId ?? v.id;
  if (!id) return null;
  const accessType = String(v.accessType || v.access_type || '').trim().toLowerCase().replace(/-/g, '_')
    || (v.isPremiumContent === true || Number(v.tokenPrice || 0) > 0 ? 'premium' : 'free');
  const requiresMembership = v.requiresMembership === true || v.requires_membership === true || accessType === 'members_only';
  const subscriptionAccess = v.subscriptionAccess === true || v.subscription_access === true || accessType === 'members_only';
  const isPremiumContent =
    v.isPremiumContent === true ||
    Number(v.tokenPrice || 0) > 0 ||
    ['premium', 'members_only', 'coin_unlock'].includes(accessType) ||
    requiresMembership ||
    subscriptionAccess;
  return {
    id: String(id),
    videoUrl: page,
    streamUrl: page,
    playbackUrl: page,
    playback_url: page,
    previewVideo: preview,
    thumbnailUrl: String(v.thumbnailUrl || ''),
    duration,
    createdAt: new Date().toISOString(),
    title: v.title || '',
    channel: v.creatorDisplayName || v.channel || '',
    creatorDisplayName: v.creatorDisplayName || v.channel || '',
    creatorAvatarUrl: v.creatorAvatarUrl || null,
    avatar: v.creatorAvatarUrl || '',
    views: v.totalViews ?? v.views ?? 0,
    totalViews: v.totalViews ?? v.views ?? 0,
    source: v.source || 'community',
    contentSource: v.contentSource || v.content_source || null,
    userId: v.userId || null,
    allowPeopleToComment: v.allowPeopleToComment !== false,
    category: v.category || v.mainOrientationCategory || '',
    mainOrientationCategory: v.mainOrientationCategory || v.category || '',
    tags: Array.isArray(v.tags) ? v.tags : [],
    isPremiumContent,
    tokenPrice: Number(v.tokenPrice) || 0,
    accessType,
    access_type: accessType,
    premiumVisibility: v.premiumVisibility || v.premium_visibility || (accessType === 'free' ? 'public' : 'public_preview'),
    premium_visibility: v.premiumVisibility || v.premium_visibility || (accessType === 'free' ? 'public' : 'public_preview'),
    requiresMembership,
    requires_membership: requiresMembership,
    subscriptionAccess,
    subscription_access: subscriptionAccess,
    officialCompanyContent: v.officialCompanyContent === true || v.official_company_content === true,
    official_company_content: v.officialCompanyContent === true || v.official_company_content === true,
    playable: v.playable !== false,
    sourceType: v.sourceType || v.source_type || 'approved_stream',
    embedAllowed: v.embedAllowed === true || v.embed_allowed === true,
    validationStatus: v.validationStatus || v.validation_status || 'playable',
  };
}

function uniquePublicVideos(rows) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const playable = annotatePlayableVideo(row);
    if (!hasRenderablePublicVideo(playable)) continue;
    const id = String(playable.id || playable.videoId || '').trim();
    const url = String(playable.playbackUrl || playable.streamUrl || playable.videoUrl || '').trim();
    const key = id ? `id:${id}` : url ? `url:${url}` : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(playable);
  }
  return out.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

async function fetchSupabaseTiktokPublicVideos({ page = 1, limit = 100, premiumOnly = false } = {}) {
  if (!isConfigured() || !supabase) return [];
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const from = 0;
  const to = (pageNum * limitNum) - 1;

  const { data, error } = await runPublicListingQuery((filterPublicRows) => {
    let query = filterPublicRows(supabase.from('tiktok_videos').select('*'));
    if (premiumOnly) query = query.eq('is_premium_content', true);
    return query.order('created_at', { ascending: false }).range(from, to);
  });

  if (error || !Array.isArray(data) || data.length === 0) return [];
  const mapped = data.map(mapTiktokRowToPublicVideo).filter(Boolean);
  return Promise.all(mapped.map((m) => mergeCreatorIntoPublicVideo(m)));
}

async function fetchSupabaseMediaPublicVideos({ page = 1, limit = 100, premiumOnly = false } = {}) {
  if (!isConfigured() || !supabase) return [];
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const to = (pageNum * limitNum) - 1;
  try {
    let query = supabase.from('media').select('*').order('created_at', { ascending: false }).range(0, to);
    if (!premiumOnly) {
      query = query.eq('type', 'video');
    }
    const { data, error } = await query;
    if (error) {
      if (isMissingTableError(error)) return [];
      let fallback = supabase.from('media').select('*').order('created_at', { ascending: false }).range(0, to);
      const retry = await fallback;
      if (retry.error) return [];
      const mappedRetry = (retry.data || []).map((row) => mapMediaRowToPublicVideo(row, 'media')).filter(Boolean);
      const filteredRetry = premiumOnly ? mappedRetry.filter((v) => v.isPremiumContent === true) : mappedRetry;
      return Promise.all(filteredRetry.map((m) => mergeCreatorIntoPublicVideo(m)));
    }
    const mapped = (data || []).map((row) => mapMediaRowToPublicVideo(row, 'media')).filter(Boolean);
    const filtered = premiumOnly ? mapped.filter((v) => v.isPremiumContent === true) : mapped;
    return Promise.all(filtered.map((m) => mergeCreatorIntoPublicVideo(m)));
  } catch {
    return [];
  }
}

async function fetchRtdbPublicVideos({ limit = 500, premiumOnly = false } = {}) {
  const rtdb = getFirebaseRtdb();
  if (!rtdb) return [];
  try {
    const snap = await rtdb.ref('videos').once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') return [];
    const mapped = Object.entries(val)
      .map(([id, row]) => mapRtdbVideoRowToPublicVideo(id, row))
      .filter(Boolean)
      .filter((v) => !premiumOnly || v.isPremiumContent === true)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, Math.min(500, Math.max(1, Number(limit) || 500)));
    return Promise.all(mapped.map((m) => mergeCreatorIntoPublicVideo(m)));
  } catch {
    return [];
  }
}

async function fetchRtdbMediaPublicVideos({ limit = 500, premiumOnly = false } = {}) {
  const rtdb = getFirebaseRtdb();
  if (!rtdb) return [];
  try {
    const snap = await rtdb.ref('media').once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') return [];
    const mapped = Object.entries(val)
      .map(([id, row]) => mapMediaRowToPublicVideo({ ...(typeof row === 'object' && row ? row : {}), id: row?.id || id }, 'media'))
      .filter(Boolean)
      .filter((v) => !premiumOnly || v.isPremiumContent === true)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, Math.min(500, Math.max(1, Number(limit) || 500)));
    return Promise.all(mapped.map((m) => mergeCreatorIntoPublicVideo(m)));
  } catch {
    return [];
  }
}

async function fetchAllCreatorPublicVideos({ page = 1, limit = 100, premiumOnly = false } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const fetchLimit = Math.min(500, pageNum * limitNum);
  const [tiktokRows, mediaRows, rtdbRows, rtdbMediaRows] = await Promise.all([
    fetchSupabaseTiktokPublicVideos({ page: pageNum, limit: limitNum, premiumOnly }),
    fetchSupabaseMediaPublicVideos({ page: pageNum, limit: limitNum, premiumOnly }),
    fetchRtdbPublicVideos({ limit: fetchLimit, premiumOnly }),
    fetchRtdbMediaPublicVideos({ limit: fetchLimit, premiumOnly }),
  ]);
  return uniquePublicVideos([...tiktokRows, ...mediaRows, ...rtdbRows, ...rtdbMediaRows]);
}

export async function fetchPublishedPublicVideos({ page = 1, limit = 100, premiumOnly = false } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const from = (pageNum - 1) * limitNum;
  const rows = await fetchAllCreatorPublicVideos({ page: pageNum, limit: limitNum, premiumOnly });
  return rows.slice(from, from + limitNum);
}

/**
 * @param {{ page: number, pagesCount: number }} opts page 1-based, pagesCount merged "pages" width
 * @returns {Promise<Array>} home-card shaped rows
 */
export async function fetchPublishedHomeCards({ page, pagesCount, viewerUid = null }) {
  const pageNum = Math.max(1, Number(page) || 1);
  const pages = Math.min(5, Math.max(1, Number(pagesCount) || 1));
  const pageSize = Math.min(200, 20 * pages);
  const rows = await fetchPublishedPublicVideos({ page: pageNum, limit: pageSize });
  return rows.map((v, i) => publicVideoToHomeCard(v, i)).filter(Boolean);
}

/**
 * Paginated feed rows for GET /api/videos when xnxx is disabled.
 * @param {{ page: number, limit: number }} opts
 */
export async function fetchPublishedFeedPage({ page, limit, viewerUid = null }) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
  const rows = await fetchPublishedPublicVideos({ page: pageNum, limit: limitNum });
  return rows.map((v, i) => publicVideoToFeedItem(v, i)).filter(Boolean);
}

/**
 * Single published video for detail resolution when cache/xnxx miss.
 */
export async function fetchPublishedVideoById(videoId, viewerUid = null) {
  const lookup = String(videoId || '').trim();
  if (!lookup) return null;

  if (isConfigured() && supabase) {
    const { data, error } = await runPublicListingQuery((filterPublicRows) => (
      filterPublicRows(supabase.from('tiktok_videos').select('*').eq('video_id', lookup))
        .maybeSingle()
    ));
    if (!error && data) {
      const m = mapTiktokRowToPublicVideo(data);
      if (m) {
        const playable = annotatePlayableVideo(await mergeCreatorIntoPublicVideo(m));
        if (hasRenderablePublicVideo(playable)) return publicVideoToDetailItem(playable);
      }
    }
  }

  const rows = await fetchAllCreatorPublicVideos({ page: 1, limit: 500 });
  const v = rows.find((row) => {
    const id = String(row.id || row.videoId || '').trim();
    return id === lookup || getPathSafeVideoId(id) === lookup;
  });
  if (!v) return null;
  return publicVideoToDetailItem(v);
}

function publicVideoToDetailItem(v) {
  const page = String(v.playbackUrl || v.streamUrl || v.videoUrl || '').trim();
  const preview = String(v.previewVideo || '').trim();
  return {
    id: String(v.videoId || v.id),
    videoId: String(v.videoId || v.id),
    video_id: String(v.videoId || v.id),
    videoUrl: page,
    streamUrl: page,
    playbackUrl: page,
    playback_url: page,
    previewVideo: preview,
    thumbnailUrl: String(v.thumbnailUrl || ''),
    duration: Number(v.durationSeconds) || 0,
    createdAt: v.createdAt ? new Date(Number(v.createdAt)).toISOString() : new Date().toISOString(),
    title: v.title || '',
    channel: v.creatorDisplayName || '',
    creatorDisplayName: v.creatorDisplayName || '',
    creatorAvatarUrl: v.creatorAvatarUrl || null,
    avatar: v.creatorAvatarUrl || '',
    views: v.totalViews ?? 0,
    totalViews: v.totalViews ?? 0,
    totalLikes: v.totalLikes ?? 0,
    totalComments: v.totalComments ?? 0,
    source: v.source || 'community',
    userId: v.userId || null,
    allowPeopleToComment: v.allowPeopleToComment !== false,
    isPremiumContent: v.isPremiumContent === true,
    tokenPrice: Number(v.tokenPrice) || 0,
    category: v.category || v.mainOrientationCategory || '',
    mainOrientationCategory: v.mainOrientationCategory || v.category || '',
    tags: Array.isArray(v.tags) ? v.tags : [],
    playable: v.playable !== false,
    sourceType: v.sourceType || v.source_type || 'approved_stream',
    embedAllowed: v.embedAllowed === true || v.embed_allowed === true,
    validationStatus: v.validationStatus || v.validation_status || 'playable',
  };
}
