/**
 * Published TikTok-style videos from Supabase for guests when external xnxx feed is off or empty.
 */
import { supabase, isConfigured } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';
import { mergeCreatorIntoPublicVideo } from './creatorProfile.js';
import { getPathSafeVideoId } from './videoPathId.js';
import { annotatePlayableVideo, isDirectPlayableStreamUrl, isPlayableVideo } from './videoPlaybackValidation.js';
import { resolveMediaDeliveryUrl } from '../services/mediaRedundancy.service.js';

const CONSENT_QUESTION = 'Do you confirm you have permission to post this video?';
const LEGACY_MEDIA_PREFIX = 'media-';
const PUBLIC_FEED_CACHE_TTL_MS = Math.max(5_000, Number(process.env.PUBLIC_VIDEO_FEED_CACHE_TTL_MS || 20_000));
const PUBLIC_FEED_CACHE_MAX_KEYS = Math.max(10, Number(process.env.PUBLIC_VIDEO_FEED_CACHE_MAX_KEYS || 80));
const VIDEO_DELIVERY_SLOW_QUERY_MS = Math.max(50, Number(process.env.VIDEO_DELIVERY_SLOW_QUERY_MS || 250));
const VIDEO_DELIVERY_DIAGNOSTICS = String(process.env.VIDEO_DELIVERY_DIAGNOSTICS || '').toLowerCase() === 'true';
const PUBLIC_FEED_SOURCE_TIMEOUT_MS = Math.max(500, Number(process.env.PUBLIC_VIDEO_FEED_SOURCE_TIMEOUT_MS || 2500));
const PUBLIC_VIDEO_COUNT_CACHE_TTL_MS = Math.max(5_000, Number(process.env.PUBLIC_VIDEO_COUNT_CACHE_TTL_MS || 30_000));

const publicFeedCache = new Map();
const publicCountCache = new Map();
const missingSelectColumnsByLabel = new Map();

const TIKTOK_PUBLIC_SELECT_COLUMNS = [
  'video_id',
  'user_id',
  'creator_id',
  'title',
  'description',
  'main_orientation_category',
  'tags',
  'allow_people_to_comment',
  'storage_url',
  'stream_url',
  'primary_url',
  'backup_url',
  'thumbnail_url',
  'duration_seconds',
  'duration',
  'creator_display_name',
  'creator_avatar_url',
  'consent_given',
  'is_live',
  'is_premium_content',
  'token_price',
  'coin_price',
  'access_type',
  'premium_visibility',
  'requires_membership',
  'subscription_access',
  'official_company_content',
  'likes_count',
  'comments_count',
  'views_count',
  'created_at',
  'status',
  'visibility',
  'deleted_at',
  'content_source',
  'playable',
  'source_type',
  'embed_allowed',
  'validation_status',
  'playback_url',
];

const IMPORTED_PUBLIC_SELECT_COLUMNS = [
  'id',
  'video_url',
  'iframe_embed',
  'playback_type',
  'title',
  'duration',
  'thumbnail_url',
  'tags',
  'actors',
  'views',
  'category',
  'quality',
  'studio',
  'publish_date',
  'metadata',
  'video_fingerprint',
  'import_job_id',
  'source_row_number',
  'created_at',
  'updated_at',
  'import_jobs(status)',
];

const MEDIA_PUBLIC_SELECT_COLUMNS = [
  'id',
  'media_id',
  'path',
  'storage_url',
  'stream_url',
  'video_url',
  'primary_url',
  'backup_url',
  'url',
  'public_url',
  'thumbnail_url',
  'thumbnail',
  'poster_url',
  'poster',
  'type',
  'media_type',
  'content_type',
  'mime_type',
  'bucket',
  'user_id',
  'title',
  'name',
  'description',
  'main_orientation_category',
  'category',
  'tags',
  'duration_seconds',
  'duration',
  'creator_display_name',
  'creator_avatar_url',
  'is_premium_content',
  'token_price',
  'access_type',
  'premium_visibility',
  'requires_membership',
  'subscription_access',
  'likes_count',
  'comments_count',
  'views_count',
  'views',
  'created_at',
  'updated_at',
  'status',
  'visibility',
  'is_live',
];

function cloneRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
}

function getCachedFeed(key) {
  const hit = publicFeedCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > PUBLIC_FEED_CACHE_TTL_MS) {
    publicFeedCache.delete(key);
    return null;
  }
  return cloneRows(hit.rows);
}

function setCachedFeed(key, rows) {
  if (!Array.isArray(rows)) return;
  publicFeedCache.set(key, { ts: Date.now(), rows: cloneRows(rows) });
  while (publicFeedCache.size > PUBLIC_FEED_CACHE_MAX_KEYS) {
    const oldest = publicFeedCache.keys().next().value;
    if (!oldest) break;
    publicFeedCache.delete(oldest);
  }
}

function getCachedCount(key) {
  const hit = publicCountCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > PUBLIC_VIDEO_COUNT_CACHE_TTL_MS) {
    publicCountCache.delete(key);
    return null;
  }
  return hit.count;
}

function setCachedCount(key, count) {
  publicCountCache.set(key, { ts: Date.now(), count: Number(count) || 0 });
  while (publicCountCache.size > PUBLIC_FEED_CACHE_MAX_KEYS) {
    const oldest = publicCountCache.keys().next().value;
    if (!oldest) break;
    publicCountCache.delete(oldest);
  }
}

function logDeliveryTiming(label, startMs, meta = {}) {
  const durationMs = Date.now() - startMs;
  if (!VIDEO_DELIVERY_DIAGNOSTICS && durationMs < VIDEO_DELIVERY_SLOW_QUERY_MS) return;
  console.info('[video-delivery] query timing', {
    label,
    durationMs,
    ...meta,
  });
}

async function timedDelivery(label, fn, meta = {}) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    logDeliveryTiming(label, startedAt, {
      ...meta,
      count: Array.isArray(result?.data) ? result.data.length : undefined,
      error: result?.error?.message || undefined,
    });
    return result;
  } catch (error) {
    logDeliveryTiming(label, startedAt, { ...meta, error: error?.message || String(error) });
    throw error;
  }
}

function withDeliveryTimeout(label, promise, fallback = []) {
  let timer = null;
  const startedAt = Date.now();
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        logDeliveryTiming(label, startedAt, { timeout: true });
        resolve(fallback);
      }, PUBLIC_FEED_SOURCE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).catch((error) => {
    logDeliveryTiming(label, startedAt, { error: error?.message || String(error) });
    return fallback;
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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

function extractMissingColumnName(err) {
  const msg = String(err?.message || '');
  const quoted = msg.match(/'([^']+)'/);
  if (quoted?.[1]) return quoted[1];
  const named = msg.match(/column\s+["']?([a-zA-Z0-9_]+)["']?/i);
  if (named?.[1]) return named[1];
  return null;
}

function getMissingSelectColumns(label) {
  if (!missingSelectColumnsByLabel.has(label)) missingSelectColumnsByLabel.set(label, new Set());
  return missingSelectColumnsByLabel.get(label);
}

async function runSelectWithColumnFallback(columns, runQuery, label) {
  const knownMissing = getMissingSelectColumns(label);
  let active = columns.filter((column) => !knownMissing.has(column));
  const removed = [];
  const maxAttempts = Math.min(40, active.length + 2);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await runQuery(active.length ? active.join(',') : '*');
    if (!result?.error) {
      if (removed.length && VIDEO_DELIVERY_DIAGNOSTICS) {
        console.warn('[video-delivery] lean select removed missing columns', { label, removed });
      }
      return result;
    }
    const missing = extractMissingColumnName(result.error);
    if (missing && active.includes(missing)) {
      knownMissing.add(missing);
      active = active.filter((column) => column !== missing);
      removed.push(missing);
      continue;
    }
    return result;
  }
  return runQuery('*');
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

function getPlaybackTypeForPublicVideo(video = {}) {
  const iframeEmbed = String(video.iframeEmbed || video.iframe_embed || '').trim();
  if (iframeEmbed) return 'external_embed';
  const explicit = String(video.playbackType || video.playback_type || '').trim().toLowerCase();
  if (explicit) return explicit;
  const source = String(video.source || video.contentSource || video.content_source || '').trim().toLowerCase();
  return ['imported_csv', 'imported', 'external_catalog', 'official_import', 'csv_import'].includes(source)
    ? 'external_redirect'
    : 'internal';
}

function normalizeAccessType(video = {}) {
  return String(video.accessType || video.access_type || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
}

function isProtectedAccessRecord(video = {}) {
  const accessType = normalizeAccessType(video);
  const premiumVisibility = String(video.premiumVisibility || video.premium_visibility || '')
    .trim()
    .toLowerCase();
  return (
    video.isPremiumContent === true ||
    video.is_premium_content === true ||
    video.isPremium === true ||
    video.premium === true ||
    Number(video.tokenPrice ?? video.token_price ?? video.coinPrice ?? video.coin_price ?? 0) > 0 ||
    video.requiresMembership === true ||
    video.requires_membership === true ||
    video.subscriptionAccess === true ||
    video.subscription_access === true ||
    ['premium', 'members_only', 'coin_unlock', 'paid'].includes(accessType) ||
    ['locked', 'paid', 'premium'].includes(premiumVisibility)
  );
}

function isImportedSource(video = {}) {
  const source = String(video.source || video.contentSource || video.content_source || '').trim().toLowerCase();
  const sourceType = String(video.sourceType || video.source_type || '').trim().toLowerCase();
  return ['imported_csv', 'imported', 'external_catalog', 'official_import', 'csv_import'].includes(source) ||
    ['imported_csv', 'imported', 'external_catalog', 'official_import', 'csv_import'].includes(sourceType) ||
    sourceType.includes('imported');
}

function normalizeCategoryFilter(value) {
  return String(value || '')
    .trim()
    .replace(/^category:/i, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function humanizeCategoryFilter(value) {
  const normalized = normalizeCategoryFilter(value);
  if (!normalized) return '';
  const acronyms = new Set(['ai', 'asmr', 'bbw', 'milf']);
  return normalized
    .replace(/_/g, ' ')
    .split(' ')
    .map((part) => (acronyms.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function categoryFilterVariants(value) {
  const raw = String(value || '').replace(/^category:/i, '').trim();
  const normalized = normalizeCategoryFilter(raw);
  if (!normalized) return [];
  return [...new Set([
    raw,
    normalized,
    normalized.replace(/_/g, '-'),
    humanizeCategoryFilter(normalized),
  ].map((item) => String(item || '').trim()).filter(Boolean))];
}

function applyCategoryFilter(query, columnName, category) {
  const variants = categoryFilterVariants(category);
  if (!variants.length) return query;
  return variants.length === 1 ? query.eq(columnName, variants[0]) : query.in(columnName, variants);
}

function publicVideoMatchesCategory(video = {}, category) {
  const wanted = normalizeCategoryFilter(category);
  if (!wanted) return true;
  const candidates = [
    video.category,
    video.mainOrientationCategory,
    video.main_orientation_category,
  ];
  return candidates.some((value) => normalizeCategoryFilter(value) === wanted);
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
  const primaryUrl = String(
    row.videoUrl ||
    row.video_url ||
    row.primary_url ||
    row.streamUrl ||
    row.stream_url ||
    row.storage_url ||
    row.url ||
    row.publicUrl ||
    row.public_url ||
    ''
  ).trim();
  return resolveMediaDeliveryUrl({
    primaryUrl,
    backupUrl: row.backup_url || row.backupUrl || '',
  });
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
  const thumb = getPrimaryThumbnailUrl(v);
  const url = getPrimaryVideoUrl(v);
  const source = String(v.source || v.contentSource || v.content_source || '').toLowerCase();
  const listableExternal =
    (v.listableInFeed === true || v.feedVisible === true) ||
    (['imported_csv', 'imported', 'external_catalog'].includes(source) && thumb && /^https?:\/\//i.test(url));
  return Boolean(v.id || v.videoId) && Boolean(title || thumb || url) && (listableExternal || isPlayableVideo(v));
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
  const videoUrl = getPrimaryVideoUrl(row);
  return {
    id: row.video_id,
    videoId: row.video_id,
    userId: row.user_id || row.creator_id,
    user_id: row.user_id || row.creator_id,
    creatorId: row.creator_id || row.user_id,
    creator_id: row.creator_id || row.user_id,
    title: row.title || '',
    description: row.description || '',
    mainOrientationCategory: row.main_orientation_category || '',
    category: row.main_orientation_category || '',
    tags: row.tags || [],
    allowPeopleToComment: row.allow_people_to_comment !== false,
    videoUrl,
    streamUrl: videoUrl,
    thumbnailUrl: row.thumbnail_url || null,
    durationSeconds: Number(row.duration_seconds ?? row.duration ?? 0),
    creatorDisplayName: row.creator_display_name || null,
    creatorAvatarUrl: row.creator_avatar_url || null,
    consentQuestion: CONSENT_QUESTION,
    consentGiven: row.consent_given === true,
    isLive: row.is_live === true,
    isPremiumContent: row.is_premium_content === true || row.requires_membership === true || row.subscription_access === true,
    tokenPrice: Number(row.token_price || row.coin_price || 0),
    accessType: row.requires_membership === true || row.subscription_access === true ? 'coin_unlock' : row.access_type || (row.is_premium_content === true ? 'premium' : 'free'),
    premiumVisibility: row.premium_visibility || null,
    requiresMembership: false,
    subscriptionAccess: false,
    officialCompanyContent: row.official_company_content === true,
    totalLikes: Number(row.likes_count || 0),
    totalComments: Number(row.comments_count || 0),
    totalViews: Number(row.views_count || 0),
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    source: row.content_source || (row.official_company_content === true ? 'imported' : 'community'),
    contentSource: row.content_source || null,
    creatorPriority: Boolean(row.user_id),
  };
}

function creatorPriorityRank(v = {}) {
  const hasCreator = Boolean(v.userId || v.user_id || v.creatorId || v.creator_id);
  if (hasCreator) return 0;
  const source = String(v.source || v.contentSource || v.content_source || '').toLowerCase();
  if (['community', 'creator', 'rtdb', 'media', 'official_import'].includes(source)) return 0;
  if (v.officialCompanyContent === true || v.official_company_content === true) return 1;
  return 2;
}

function hasCreatorPriority(v = {}) {
  return creatorPriorityRank(v) === 0;
}

function mapImportedVideoRowToPublicVideo(row) {
  if (!row || typeof row !== 'object') return null;
  const iframeEmbed = row.iframe_embed || '';
  const playbackType = iframeEmbed ? 'external_embed' : (row.playback_type || 'external_redirect');
  return {
    id: row.id,
    videoId: row.id,
    userId: row.creator_id || null,
    creatorId: row.creator_id || null,
    creator_id: row.creator_id || null,
    title: row.title || '',
    description: row.title || '',
    mainOrientationCategory: row.category || '',
    category: row.category || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    actors: Array.isArray(row.actors) ? row.actors : [],
    allowPeopleToComment: false,
    videoUrl: row.video_url || '',
    video_url: row.video_url || '',
    iframeEmbed,
    iframe_embed: iframeEmbed,
    playbackType,
    playback_type: playbackType,
    thumbnailUrl: row.thumbnail_url || null,
    thumbnail_url: row.thumbnail_url || null,
    durationSeconds: Number(row.duration || 0),
    creatorDisplayName: row.studio || 'Imported catalog',
    creatorAvatarUrl: null,
    consentQuestion: CONSENT_QUESTION,
    consentGiven: true,
    isLive: true,
    isPremiumContent: false,
    tokenPrice: 0,
    accessType: 'free',
    premiumVisibility: 'public',
    requiresMembership: false,
    subscriptionAccess: false,
    officialCompanyContent: true,
    totalLikes: 0,
    totalComments: 0,
    totalViews: Number(row.views || 0),
    createdAt: toTimestamp(row.publish_date || row.created_at),
    source: row.creator_id ? 'community' : 'imported_csv',
    contentSource: 'imported_csv',
    creatorPriority: Boolean(row.creator_id),
    pageUrl: row.video_url || '',
    page_url: row.video_url || '',
    externalUrl: row.video_url || '',
    external_url: row.video_url || '',
    playable: Boolean(iframeEmbed),
    listableInFeed: Boolean(row.thumbnail_url || row.title || row.video_url),
    feedVisible: Boolean(row.thumbnail_url || row.title || row.video_url),
    embedAllowed: Boolean(iframeEmbed),
    sourceType: iframeEmbed ? 'external_embed' : 'external_page',
    validationStatus: iframeEmbed ? 'playable' : 'external_page',
    playbackUrl: iframeEmbed ? '' : null,
    playback_url: iframeEmbed ? '' : null,
    streamUrl: iframeEmbed ? '' : row.video_url || '',
    stream_url: iframeEmbed ? '' : row.video_url || '',
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
    user_id: row.userId || row.user_id || row.uid || null,
    creatorId: row.userId || row.user_id || row.uid || null,
    creator_id: row.userId || row.user_id || row.uid || null,
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
    isPremiumContent: row.isPremiumContent === true || Number(row.tokenPrice || row.coin_price || 0) > 0 || row.requiresMembership === true || row.requires_membership === true || row.subscriptionAccess === true || row.subscription_access === true,
    tokenPrice: Number(row.tokenPrice || row.coin_price || 0),
    accessType: row.requiresMembership === true || row.requires_membership === true || row.subscriptionAccess === true || row.subscription_access === true ? 'coin_unlock' : row.accessType || row.access_type || (row.isPremiumContent ? 'premium' : 'free'),
    premiumVisibility: row.premiumVisibility || row.premium_visibility || null,
    requiresMembership: false,
    subscriptionAccess: false,
    totalLikes: Number(row.totalLikes || row.likes_count || 0),
    totalComments: Number(row.totalComments || row.comments_count || 0),
    totalViews: Number(row.totalViews ?? row.views ?? row.views_count ?? 0) || 0,
    createdAt: toTimestamp(row.createdAt || row.created_at || row.updatedAt || row.updated_at),
    source: 'rtdb',
    creatorPriority: true,
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
    user_id: row.user_id || row.userId || row.uid || null,
    creatorId: row.user_id || row.userId || row.uid || null,
    creator_id: row.user_id || row.userId || row.uid || null,
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
    isPremiumContent: row.is_premium_content === true || row.isPremiumContent === true || Number(row.token_price || row.tokenPrice || 0) > 0 || row.requires_membership === true || row.requiresMembership === true || row.subscription_access === true || row.subscriptionAccess === true,
    tokenPrice: Number(row.token_price || row.tokenPrice || 0),
    accessType: row.requires_membership === true || row.requiresMembership === true || row.subscription_access === true || row.subscriptionAccess === true ? 'coin_unlock' : row.access_type || row.accessType || (row.is_premium_content === true || row.isPremiumContent === true ? 'premium' : 'free'),
    premiumVisibility: row.premium_visibility || row.premiumVisibility || null,
    requiresMembership: false,
    subscriptionAccess: false,
    totalLikes: Number(row.likes_count || row.totalLikes || 0),
    totalComments: Number(row.comments_count || row.totalComments || 0),
    totalViews: Number(row.views_count ?? row.totalViews ?? row.views ?? 0) || 0,
    createdAt: toTimestamp(row.created_at || row.createdAt || row.updated_at || row.updatedAt),
    source,
    creatorPriority: Boolean(row.user_id || row.userId || row.uid),
  };
}

function formatDuration(seconds) {
  const n = Math.floor(Number(seconds) || 0);
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getPublicVideoPlaybackShape(v = {}) {
  if (isProtectedAccessRecord(v)) {
    return {
      iframeEmbed: '',
      playbackType: 'protected_stream',
      isExternalEmbed: false,
      pageUrl: '',
      playbackUrl: '',
      streamUrl: '',
      sourceType: 'protected_stream',
      embedAllowed: false,
      externalUrl: '',
    };
  }

  const iframeEmbed = String(v.iframeEmbed || v.iframe_embed || '').trim();
  const playbackType = getPlaybackTypeForPublicVideo({ ...v, iframeEmbed, iframe_embed: iframeEmbed });
  const externalPageUrl = String(
    v.videoUrl ||
    v.video_url ||
    v.pageUrl ||
    v.page_url ||
    v.externalUrl ||
    v.external_url ||
    v.url ||
    ''
  ).trim();
  const rawPlaybackUrl = String(
    v.playbackUrl ||
    v.playback_url ||
    v.streamUrl ||
    v.stream_url ||
    v.storageUrl ||
    v.storage_url ||
    ''
  ).trim();
  const allowImportedDirectHost = isImportedSource(v) || String(v.sourceType || v.source_type || '').toLowerCase().includes('imported');
  const directPlaybackUrl = isDirectPlayableStreamUrl(rawPlaybackUrl, { allowUnapprovedDirectHost: allowImportedDirectHost })
    ? rawPlaybackUrl
    : '';
  const isExternalEmbed = !directPlaybackUrl && (playbackType.toLowerCase() === 'external_embed' || iframeEmbed.length > 0);
  const playbackUrl = isExternalEmbed ? '' : (directPlaybackUrl || rawPlaybackUrl || externalPageUrl);
  const effectivePlaybackType = directPlaybackUrl ? 'internal' : playbackType;
  const pageUrl = externalPageUrl || rawPlaybackUrl;

  return {
    iframeEmbed,
    playbackType: effectivePlaybackType,
    isExternalEmbed,
    pageUrl,
    playbackUrl,
    streamUrl: directPlaybackUrl || (isExternalEmbed ? '' : playbackUrl),
    sourceType: directPlaybackUrl ? 'imported_direct_stream' : (isExternalEmbed ? 'external_embed' : ''),
    embedAllowed: isExternalEmbed,
    externalUrl: String(v.externalUrl || v.external_url || v.pageUrl || v.page_url || externalPageUrl || pageUrl || '').trim(),
  };
}

/** Same shape as mapRawToHomeCard (xnxxRapidApi) for home-feed + VideoFeed.jsx */
export function publicVideoToHomeCard(v, index) {
  if (!v || typeof v !== 'object') return null;
  const id = v.videoId ?? v.id;
  if (!id) return null;
  const playback = getPublicVideoPlaybackShape(v);
  const preview = isProtectedAccessRecord(v) ? '' : String(v.previewVideo || '').trim();
  const thumb = getPrimaryThumbnailUrl(v);
  const dur = Number(v.durationSeconds) || 0;
  const title = v.title || 'Video';
  const seed = String(v.userId || id || title).slice(0, 50);
  const rawAccessType = String(v.accessType || v.access_type || '').trim().toLowerCase().replace(/-/g, '_')
    || (v.isPremiumContent === true || Number(v.tokenPrice || 0) > 0 ? 'premium' : 'free');
  const legacyCoinGate = v.requiresMembership === true || v.requires_membership === true || v.subscriptionAccess === true || v.subscription_access === true || rawAccessType === 'members_only';
  const accessType = legacyCoinGate ? 'coin_unlock' : rawAccessType;
  const isPremiumContent =
    v.isPremiumContent === true ||
    Number(v.tokenPrice || 0) > 0 ||
    ['premium', 'coin_unlock'].includes(accessType) ||
    legacyCoinGate;
  return {
    id: String(id),
    title: String(title),
    channel: String(v.creatorDisplayName || v.channel || 'Creator'),
    views: v.totalViews ?? v.views ?? 0,
    thumbnail: thumb,
    thumbnailUrl: thumb,
    thumbnail_url: thumb,
    duration: formatDuration(dur),
    durationSeconds: dur,
    avatar: v.creatorAvatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seed)}`,
    creatorDisplayName: v.creatorDisplayName || v.channel || 'Creator',
    creatorAvatarUrl: v.creatorAvatarUrl || null,
    videoSrc: preview || playback.playbackUrl || (playback.isExternalEmbed ? '' : playback.pageUrl),
    videoUrl: playback.pageUrl,
    video_url: playback.pageUrl,
    streamUrl: playback.streamUrl,
    stream_url: playback.streamUrl,
    playbackUrl: playback.playbackUrl,
    playback_url: playback.playbackUrl,
    iframeEmbed: playback.iframeEmbed,
    iframe_embed: playback.iframeEmbed,
    playbackType: playback.playbackType,
    playback_type: playback.playbackType,
    previewVideo: preview || undefined,
    pageUrl: playback.pageUrl,
    page_url: playback.pageUrl,
    externalUrl: playback.externalUrl,
    external_url: playback.externalUrl,
    likes: String(v.totalLikes ?? 0),
    comments: String(v.totalComments ?? 0),
    time: '',
    description: title ? `Watch ${title}.` : 'Watch this video.',
    source: v.source || 'community',
    contentSource: v.contentSource || v.content_source || null,
    userId: v.userId || v.user_id || null,
    user_id: v.userId || v.user_id || null,
    creatorId: v.creatorId || v.creator_id || v.userId || v.user_id || null,
    creator_id: v.creatorId || v.creator_id || v.userId || v.user_id || null,
    creatorPriority: hasCreatorPriority(v),
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
    requiresMembership: false,
    requires_membership: false,
    subscriptionAccess: false,
    subscription_access: false,
    officialCompanyContent: v.officialCompanyContent === true || v.official_company_content === true,
    official_company_content: v.officialCompanyContent === true || v.official_company_content === true,
    playable: Boolean(playback.playbackUrl) || playback.isExternalEmbed || v.playable === true,
    listableInFeed: Boolean(playback.playbackUrl) || playback.isExternalEmbed || v.listableInFeed === true || v.feedVisible === true,
    feedVisible: Boolean(playback.playbackUrl) || playback.isExternalEmbed || v.listableInFeed === true || v.feedVisible === true,
    sourceType: playback.sourceType || v.sourceType || v.source_type || (v.playable === false ? 'external_page' : 'approved_stream'),
    source_type: playback.sourceType || v.sourceType || v.source_type || (v.playable === false ? 'external_page' : 'approved_stream'),
    embedAllowed: playback.playbackType === 'internal' ? false : (playback.embedAllowed || v.embedAllowed === true || v.embed_allowed === true),
    embed_allowed: playback.playbackType === 'internal' ? false : (playback.embedAllowed || v.embedAllowed === true || v.embed_allowed === true),
    validationStatus: v.validationStatus || v.validation_status || (playback.isExternalEmbed ? 'playable' : (v.playable === false ? 'external_page' : 'playable')),
    validation_status: v.validationStatus || v.validation_status || (playback.isExternalEmbed ? 'playable' : (v.playable === false ? 'external_page' : 'playable')),
  };
}

/** GET /api/videos (paginated) item shape — matches homeCardToFeedVideoItem output */
export function publicVideoToFeedItem(v, index) {
  if (!v || typeof v !== 'object') return null;
  const duration = Number(v.durationSeconds) || 0;
  const preview = isProtectedAccessRecord(v) ? '' : String(v.previewVideo || '').trim();
  const playback = getPublicVideoPlaybackShape(v);
  const id = v.videoId ?? v.id;
  if (!id) return null;
  const rawAccessType = String(v.accessType || v.access_type || '').trim().toLowerCase().replace(/-/g, '_')
    || (v.isPremiumContent === true || Number(v.tokenPrice || 0) > 0 ? 'premium' : 'free');
  const legacyCoinGate = v.requiresMembership === true || v.requires_membership === true || v.subscriptionAccess === true || v.subscription_access === true || rawAccessType === 'members_only';
  const accessType = legacyCoinGate ? 'coin_unlock' : rawAccessType;
  const isPremiumContent =
    v.isPremiumContent === true ||
    Number(v.tokenPrice || 0) > 0 ||
    ['premium', 'coin_unlock'].includes(accessType) ||
    legacyCoinGate;
  return {
    id: String(id),
    videoUrl: playback.pageUrl,
    video_url: playback.pageUrl,
    streamUrl: playback.streamUrl,
    stream_url: playback.streamUrl,
    playbackUrl: playback.playbackUrl,
    playback_url: playback.playbackUrl,
    iframeEmbed: playback.iframeEmbed,
    iframe_embed: playback.iframeEmbed,
    playbackType: playback.playbackType,
    playback_type: playback.playbackType,
    previewVideo: preview,
    thumbnailUrl: getPrimaryThumbnailUrl(v),
    thumbnail_url: getPrimaryThumbnailUrl(v),
    thumbnail: getPrimaryThumbnailUrl(v),
    pageUrl: playback.pageUrl,
    page_url: playback.pageUrl,
    externalUrl: playback.externalUrl,
    external_url: playback.externalUrl,
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
    userId: v.userId || v.user_id || null,
    user_id: v.userId || v.user_id || null,
    creatorId: v.creatorId || v.creator_id || v.userId || v.user_id || null,
    creator_id: v.creatorId || v.creator_id || v.userId || v.user_id || null,
    creatorPriority: hasCreatorPriority(v),
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
    requiresMembership: false,
    requires_membership: false,
    subscriptionAccess: false,
    subscription_access: false,
    officialCompanyContent: v.officialCompanyContent === true || v.official_company_content === true,
    official_company_content: v.officialCompanyContent === true || v.official_company_content === true,
    playable: Boolean(playback.playbackUrl) || playback.isExternalEmbed || v.playable === true,
    listableInFeed: Boolean(playback.playbackUrl) || playback.isExternalEmbed || v.listableInFeed === true || v.feedVisible === true,
    feedVisible: Boolean(playback.playbackUrl) || playback.isExternalEmbed || v.listableInFeed === true || v.feedVisible === true,
    sourceType: playback.sourceType || v.sourceType || v.source_type || (v.playable === false ? 'external_page' : 'approved_stream'),
    source_type: playback.sourceType || v.sourceType || v.source_type || (v.playable === false ? 'external_page' : 'approved_stream'),
    embedAllowed: playback.playbackType === 'internal' ? false : (playback.embedAllowed || v.embedAllowed === true || v.embed_allowed === true),
    embed_allowed: playback.playbackType === 'internal' ? false : (playback.embedAllowed || v.embedAllowed === true || v.embed_allowed === true),
    validationStatus: v.validationStatus || v.validation_status || (playback.isExternalEmbed ? 'playable' : (v.playable === false ? 'external_page' : 'playable')),
    validation_status: v.validationStatus || v.validation_status || (playback.isExternalEmbed ? 'playable' : (v.playable === false ? 'external_page' : 'playable')),
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
  return out.sort((a, b) => {
    const priority = creatorPriorityRank(a) - creatorPriorityRank(b);
    if (priority !== 0) return priority;
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
}

async function fetchSupabaseTiktokPublicVideos({ page = 1, limit = 100, premiumOnly = false, category = null } = {}) {
  if (!isConfigured() || !supabase) return [];
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const from = 0;
  const to = (pageNum * limitNum) - 1;
  const categoryFilter = normalizeCategoryFilter(category);

  const { data, error } = await runSelectWithColumnFallback(
    TIKTOK_PUBLIC_SELECT_COLUMNS,
    (selectColumns) => timedDelivery('supabase.tiktok_videos.feed', () => runPublicListingQuery((filterPublicRows) => {
      let query = filterPublicRows(supabase.from('tiktok_videos').select(selectColumns));
      if (premiumOnly) query = query.eq('is_premium_content', true);
      return query.order('created_at', { ascending: false }).range(from, to);
    }), { page: pageNum, limit: limitNum, premiumOnly, category: categoryFilter || undefined }),
    'supabase.tiktok_videos.feed',
  );

  if (error || !Array.isArray(data) || data.length === 0) return [];
  const mapped = data.map(mapTiktokRowToPublicVideo).filter(Boolean).filter((row) => publicVideoMatchesCategory(row, categoryFilter));
  return Promise.all(mapped.map((m) => mergeCreatorIntoPublicVideo(m)));
}

async function fetchSupabaseImportedPublicVideos({ page = 1, limit = 100, premiumOnly = false, category = null } = {}) {
  if (premiumOnly || !isConfigured() || !supabase) return [];
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const from = 0;
  const to = (pageNum * limitNum) - 1;
  const categoryFilter = normalizeCategoryFilter(category);

  const { data, error } = await runSelectWithColumnFallback(
    IMPORTED_PUBLIC_SELECT_COLUMNS,
    (selectColumns) => timedDelivery('supabase.videos.imported_feed', () => {
      let query = supabase
        .from('videos')
        .select(selectColumns);
      if (categoryFilter) query = applyCategoryFilter(query, 'category', categoryFilter);
      return query
        .order('created_at', { ascending: false })
        .range(from, to);
    }, { page: pageNum, limit: limitNum, category: categoryFilter || undefined }),
    'supabase.videos.imported_feed',
  );
  if (error) {
    if (isMissingTableError(error)) return [];
    return [];
  }
  return (data || []).map(mapImportedVideoRowToPublicVideo).filter(Boolean);
}

async function fetchSupabaseMediaPublicVideos({ page = 1, limit = 100, premiumOnly = false, category = null } = {}) {
  if (!isConfigured() || !supabase) return [];
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const to = (pageNum * limitNum) - 1;
  const categoryFilter = normalizeCategoryFilter(category);
  try {
    const { data, error } = await runSelectWithColumnFallback(
      MEDIA_PUBLIC_SELECT_COLUMNS,
      (selectColumns) => {
        let query = supabase.from('media').select(selectColumns).order('created_at', { ascending: false }).range(0, to);
        if (!premiumOnly) query = query.eq('type', 'video');
        return timedDelivery('supabase.media.feed', () => query, { page: pageNum, limit: limitNum, premiumOnly, category: categoryFilter || undefined });
      },
      'supabase.media.feed',
    );
    if (error) {
      if (isMissingTableError(error)) return [];
      const retry = await runSelectWithColumnFallback(
        MEDIA_PUBLIC_SELECT_COLUMNS,
        (selectColumns) => timedDelivery('supabase.media.feed_fallback', () => {
          const retryQuery = supabase
            .from('media')
            .select(selectColumns);
          return retryQuery
            .order('created_at', { ascending: false })
            .range(0, to);
        }, { page: pageNum, limit: limitNum, premiumOnly, category: categoryFilter || undefined }),
        'supabase.media.feed_fallback',
      );
      if (retry.error) return [];
      const mappedRetry = (retry.data || []).map((row) => mapMediaRowToPublicVideo(row, 'media')).filter(Boolean);
      const filteredRetry = (premiumOnly ? mappedRetry.filter((v) => v.isPremiumContent === true) : mappedRetry)
        .filter((row) => publicVideoMatchesCategory(row, categoryFilter));
      return Promise.all(filteredRetry.map((m) => mergeCreatorIntoPublicVideo(m)));
    }
    const mapped = (data || []).map((row) => mapMediaRowToPublicVideo(row, 'media')).filter(Boolean);
    const filtered = (premiumOnly ? mapped.filter((v) => v.isPremiumContent === true) : mapped)
      .filter((row) => publicVideoMatchesCategory(row, categoryFilter));
    return Promise.all(filtered.map((m) => mergeCreatorIntoPublicVideo(m)));
  } catch {
    return [];
  }
}

async function fetchRtdbPublicVideos({ limit = 500, premiumOnly = false, category = null } = {}) {
  const rtdb = getFirebaseRtdb();
  if (!rtdb) return [];
  const categoryFilter = normalizeCategoryFilter(category);
  try {
    const limitNum = Math.min(500, Math.max(1, Number(limit) || 500));
    const snap = await rtdb.ref('videos').orderByKey().limitToLast(limitNum).once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') return [];
    const mapped = Object.entries(val)
      .map(([id, row]) => mapRtdbVideoRowToPublicVideo(id, row))
      .filter(Boolean)
      .filter((v) => !premiumOnly || v.isPremiumContent === true)
      .filter((v) => publicVideoMatchesCategory(v, categoryFilter))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, limitNum);
    return Promise.all(mapped.map((m) => mergeCreatorIntoPublicVideo(m)));
  } catch {
    return [];
  }
}

async function fetchRtdbMediaPublicVideos({ limit = 500, premiumOnly = false, category = null } = {}) {
  const rtdb = getFirebaseRtdb();
  if (!rtdb) return [];
  const categoryFilter = normalizeCategoryFilter(category);
  try {
    const limitNum = Math.min(500, Math.max(1, Number(limit) || 500));
    const snap = await rtdb.ref('media').orderByKey().limitToLast(limitNum).once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') return [];
    const mapped = Object.entries(val)
      .map(([id, row]) => mapMediaRowToPublicVideo({ ...(typeof row === 'object' && row ? row : {}), id: row?.id || id }, 'media'))
      .filter(Boolean)
      .filter((v) => !premiumOnly || v.isPremiumContent === true)
      .filter((v) => publicVideoMatchesCategory(v, categoryFilter))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, limitNum);
    return Promise.all(mapped.map((m) => mergeCreatorIntoPublicVideo(m)));
  } catch {
    return [];
  }
}

async function fetchAllCreatorPublicVideos({ page = 1, limit = 100, premiumOnly = false, category = null } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const fetchLimit = Math.min(500, pageNum * limitNum);
  const categoryFilter = normalizeCategoryFilter(category);
  const [tiktokRows, importedRows, mediaRows, rtdbRows, rtdbMediaRows] = await Promise.all([
    withDeliveryTimeout('public-feed.tiktok', fetchSupabaseTiktokPublicVideos({ page: pageNum, limit: limitNum, premiumOnly, category: categoryFilter })),
    withDeliveryTimeout('public-feed.imported', fetchSupabaseImportedPublicVideos({ page: pageNum, limit: limitNum, premiumOnly, category: categoryFilter })),
    withDeliveryTimeout('public-feed.media', fetchSupabaseMediaPublicVideos({ page: pageNum, limit: limitNum, premiumOnly, category: categoryFilter })),
    withDeliveryTimeout('public-feed.rtdb-videos', fetchRtdbPublicVideos({ limit: fetchLimit, premiumOnly, category: categoryFilter })),
    withDeliveryTimeout('public-feed.rtdb-media', fetchRtdbMediaPublicVideos({ limit: fetchLimit, premiumOnly, category: categoryFilter })),
  ]);
  return uniquePublicVideos([...tiktokRows, ...importedRows, ...mediaRows, ...rtdbRows, ...rtdbMediaRows]);
}

export async function fetchPublishedPublicVideos({ page = 1, limit = 100, premiumOnly = false, category = null } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const from = (pageNum - 1) * limitNum;
  const categoryFilter = normalizeCategoryFilter(category);
  const cacheKey = `published:${pageNum}:${limitNum}:${premiumOnly ? 'premium' : 'all'}:${categoryFilter || 'all-categories'}`;
  const cached = getCachedFeed(cacheKey);
  if (cached) return cached;
  const rows = await fetchAllCreatorPublicVideos({ page: pageNum, limit: limitNum, premiumOnly, category: categoryFilter });
  const sliced = rows.slice(from, from + limitNum);
  setCachedFeed(cacheKey, sliced);
  return cloneRows(sliced);
}

async function safeCount(queryPromise) {
  try {
    const { count, error } = await queryPromise;
    if (error) return 0;
    return Number(count) || 0;
  } catch {
    return 0;
  }
}

async function countWithError(queryPromise) {
  try {
    const { count, error } = await queryPromise;
    return { count: error ? 0 : Number(count) || 0, error };
  } catch (error) {
    return { count: 0, error };
  }
}

function buildTiktokPublicCountQuery({ premiumOnly, categoryFilter, useStatusFilter = true }) {
  let query = supabase.from('tiktok_videos').select('video_id', { count: 'planned', head: true });
  query = useStatusFilter ? applyPublicListingFilter(query) : query.eq('is_live', true);
  if (premiumOnly) query = query.eq('is_premium_content', true);
  if (categoryFilter) query = applyCategoryFilter(query, 'main_orientation_category', categoryFilter);
  return query;
}

async function countTiktokPublicVideos({ premiumOnly, categoryFilter }) {
  const first = await countWithError(buildTiktokPublicCountQuery({ premiumOnly, categoryFilter, useStatusFilter: true }));
  if (!first.error) return first.count;
  if (isMissingColumnError(first.error, 'status')) {
    const fallback = await countWithError(buildTiktokPublicCountQuery({ premiumOnly, categoryFilter, useStatusFilter: false }));
    return fallback.count;
  }
  return 0;
}

export async function countPublishedPublicVideos({ premiumOnly = false, category = null } = {}) {
  if (!isConfigured() || !supabase) return 0;
  const categoryFilter = normalizeCategoryFilter(category);
  const cacheKey = `count:${premiumOnly ? 'premium' : 'all'}:${categoryFilter || 'all-categories'}`;
  const cached = getCachedCount(cacheKey);
  if (cached !== null) return cached;

  let importedQuery = supabase.from('videos').select('id', { count: 'planned', head: true });
  if (categoryFilter) importedQuery = applyCategoryFilter(importedQuery, 'category', categoryFilter);

  let mediaQuery = supabase.from('media').select('id', { count: 'planned', head: true });
  if (!premiumOnly) mediaQuery = mediaQuery.eq('type', 'video');
  if (premiumOnly) mediaQuery = mediaQuery.eq('is_premium_content', true);
  if (categoryFilter) mediaQuery = applyCategoryFilter(mediaQuery, 'category', categoryFilter);

  const counts = await Promise.all([
    safeCount(importedQuery),
    countTiktokPublicVideos({ premiumOnly, categoryFilter }),
    safeCount(mediaQuery),
  ]);

  const total = counts.reduce((sum, value) => sum + value, 0);
  setCachedCount(cacheKey, total);
  return total;
}

/**
 * @param {{ page: number, pagesCount: number }} opts page 1-based, pagesCount merged "pages" width
 * @returns {Promise<Array>} home-card shaped rows
 */
export async function fetchPublishedHomeCards({ page, pagesCount, viewerUid = null, category = null, limit = null }) {
  const pageNum = Math.max(1, Number(page) || 1);
  const pages = Math.min(5, Math.max(1, Number(pagesCount) || 1));
  const requestedLimit = Number(limit);
  const pageSize = Math.min(500, Math.max(20 * pages, Number.isFinite(requestedLimit) ? requestedLimit : 20 * pages));
  const rows = await fetchPublishedPublicVideos({ page: pageNum, limit: pageSize, category });
  return rows.map((v, i) => publicVideoToHomeCard(v, i)).filter(Boolean);
}

/**
 * Paginated feed rows for GET /api/videos when xnxx is disabled.
 * @param {{ page: number, limit: number }} opts
 */
export async function fetchPublishedFeedPage({ page, limit, viewerUid = null }) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
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
    const imported = await runSelectWithColumnFallback(
      IMPORTED_PUBLIC_SELECT_COLUMNS,
      (selectColumns) => timedDelivery('supabase.videos.imported_detail', () => supabase
        .from('videos')
        .select(selectColumns)
        .eq('id', lookup)
        .maybeSingle(), { videoId: lookup }),
      'supabase.videos.imported_detail',
    );
    if (!imported.error && imported.data) {
      const m = mapImportedVideoRowToPublicVideo(imported.data);
      const playable = annotatePlayableVideo(m);
      if (hasRenderablePublicVideo(playable)) return publicVideoToDetailItem(playable);
    }

    const { data, error } = await runPublicListingQuery((filterPublicRows) => (
      runSelectWithColumnFallback(
        TIKTOK_PUBLIC_SELECT_COLUMNS,
        (selectColumns) => filterPublicRows(supabase.from('tiktok_videos').select(selectColumns).eq('video_id', lookup))
          .maybeSingle(),
        'supabase.tiktok_videos.detail',
      )
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
  const playback = getPublicVideoPlaybackShape(v);
  const preview = isProtectedAccessRecord(v) ? '' : String(v.previewVideo || '').trim();
  return {
    id: String(v.videoId || v.id),
    videoId: String(v.videoId || v.id),
    video_id: String(v.videoId || v.id),
    videoUrl: playback.pageUrl,
    video_url: playback.pageUrl,
    streamUrl: playback.streamUrl,
    stream_url: playback.streamUrl,
    playbackUrl: playback.playbackUrl,
    playback_url: playback.playbackUrl,
    iframeEmbed: playback.iframeEmbed,
    iframe_embed: playback.iframeEmbed,
    playbackType: playback.playbackType,
    playback_type: playback.playbackType,
    previewVideo: preview,
    thumbnailUrl: getPrimaryThumbnailUrl(v),
    thumbnail_url: getPrimaryThumbnailUrl(v),
    thumbnail: getPrimaryThumbnailUrl(v),
    pageUrl: playback.pageUrl,
    page_url: playback.pageUrl,
    externalUrl: playback.externalUrl,
    external_url: playback.externalUrl,
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
    userId: v.userId || v.user_id || null,
    user_id: v.userId || v.user_id || null,
    creatorId: v.creatorId || v.creator_id || v.userId || v.user_id || null,
    creator_id: v.creatorId || v.creator_id || v.userId || v.user_id || null,
    creatorPriority: hasCreatorPriority(v),
    allowPeopleToComment: v.allowPeopleToComment !== false,
    isPremiumContent: v.isPremiumContent === true,
    tokenPrice: Number(v.tokenPrice) || 0,
    category: v.category || v.mainOrientationCategory || '',
    mainOrientationCategory: v.mainOrientationCategory || v.category || '',
    tags: Array.isArray(v.tags) ? v.tags : [],
    playable: Boolean(playback.playbackUrl) || playback.isExternalEmbed || v.playable === true,
    listableInFeed: Boolean(playback.playbackUrl) || playback.isExternalEmbed || v.listableInFeed === true || v.feedVisible === true,
    feedVisible: Boolean(playback.playbackUrl) || playback.isExternalEmbed || v.listableInFeed === true || v.feedVisible === true,
    sourceType: playback.sourceType || v.sourceType || v.source_type || (v.playable === false ? 'external_page' : 'approved_stream'),
    source_type: playback.sourceType || v.sourceType || v.source_type || (v.playable === false ? 'external_page' : 'approved_stream'),
    embedAllowed: playback.playbackType === 'internal' ? false : (playback.embedAllowed || v.embedAllowed === true || v.embed_allowed === true),
    embed_allowed: playback.playbackType === 'internal' ? false : (playback.embedAllowed || v.embedAllowed === true || v.embed_allowed === true),
    validationStatus: v.validationStatus || v.validation_status || (playback.isExternalEmbed ? 'playable' : (v.playable === false ? 'external_page' : 'playable')),
    validation_status: v.validationStatus || v.validation_status || (playback.isExternalEmbed ? 'playable' : (v.playable === false ? 'external_page' : 'playable')),
  };
}
