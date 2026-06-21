import { randomUUID } from 'crypto';
import os from 'os';
import { supabase } from '../config/supabase.js';
import {
  MEILI_INDEXES,
  VIDEOS_INDEX,
  ensureAllIndexes,
  ensureIndex,
  ensureVideosIndex,
  getMeilisearchClient,
  getMeilisearchHealth,
  getMeilisearchPublicConfig,
  isMeilisearchConfigured,
} from '../config/meilisearch.js';
import { publicVideoToHomeCard } from '../utils/platformPublicFeed.js';
import { annotatePlayableVideo, isDirectPlayableStreamUrl } from '../utils/videoPlaybackValidation.js';

const SEARCH_CACHE_TTL_MS = Math.max(5_000, Number(process.env.SEARCH_CACHE_TTL_MS || 30_000));
const IMPORT_BATCH_SIZE = Math.min(10_000, Math.max(100, Number(process.env.IMPORT_BATCH_SIZE || 10_000)));
const REINDEX_BATCH_SIZE = Math.min(IMPORT_BATCH_SIZE, Math.max(100, Number(process.env.SEARCH_REINDEX_BATCH_SIZE || 1_000)));
const MEILI_DOCUMENT_BATCH_SIZE = Math.min(REINDEX_BATCH_SIZE, Math.max(100, Number(process.env.MEILI_DOCUMENT_BATCH_SIZE || 1_000)));
const MAX_CONCURRENT_INDEX_WORKERS = Math.min(10, Math.max(1, Number(process.env.MAX_CONCURRENT_IMPORTS || process.env.SEARCH_MAX_CONCURRENT_WORKERS || 5)));
const INDEXING_QUEUE_ENABLED = String(process.env.INDEXING_QUEUE_ENABLED ?? 'true').toLowerCase() !== 'false';
const INDEXING_MAX_RETRIES = Math.min(10, Math.max(1, Number(process.env.SEARCH_INDEX_MAX_RETRIES || 5)));
const INDEXING_LOCK_TIMEOUT_MS = Math.max(60_000, Number(process.env.SEARCH_INDEX_LOCK_TIMEOUT_MS || 10 * 60_000));
const INDEXING_RETRY_BASE_DELAY_MS = Math.max(5_000, Number(process.env.SEARCH_INDEX_RETRY_BASE_DELAY_MS || 30_000));
const INDEXABLE_TYPES = new Set(['video', 'creator', 'user', 'live_stream', 'tag', 'category']);
const searchCache = new Map();
let syncScheduler = null;
let syncSchedulerRunning = false;
let batchWorkerRunning = false;
let indexingPausedFallback = false;

function isMissingFeature(err) {
  return (
    err?.code === '42P01' ||
    err?.code === '42703' ||
    err?.code === 'PGRST200' ||
    err?.code === 'PGRST204' ||
    /schema cache|does not exist|column .* does not exist/i.test(String(err?.message || ''))
  );
}

async function runOptionalSupabaseQuery(query, context = 'supabase query', fallback = null, mapResult = (result) => result) {
  try {
    const result = await query;
    if (result?.error) throw result.error;
    return mapResult(result);
  } catch (err) {
    if (!isMissingFeature(err)) {
      console.warn(`[search-index] ${context} failed:`, err?.message || err);
    }
    return fallback;
  }
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return normalizeArray(parsed);
      } catch {
        return [];
      }
    }
    return trimmed.split(/[,|;]/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

function timestamp(value, fallback = Date.now()) {
  if (!value) return fallback;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function text(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function importedPlaybackType(row = {}) {
  const iframeEmbed = text(row.iframe_embed || row.iframeEmbed);
  return iframeEmbed ? 'external_embed' : text(row.playback_type || row.playbackType || '');
}

function allowsImportedDirectHost(row = {}) {
  const source = text(row.source || row.contentSource || row.content_source).toLowerCase();
  const sourceType = text(row.sourceType || row.source_type).toLowerCase();
  return ['imported_csv', 'imported', 'external_catalog', 'official_import', 'csv_import'].includes(source) ||
    ['imported_csv', 'imported', 'external_catalog', 'official_import', 'csv_import'].includes(sourceType) ||
    sourceType.includes('imported');
}

function scoreVideo(row) {
  const views = Number(row.views_count || row.viewsCount || 0);
  const likes = Number(row.likes_count || row.likesCount || 0);
  const comments = Number(row.comments_count || row.commentsCount || 0);
  const createdAt = timestamp(row.created_at || row.createdAt, Date.now());
  const ageHours = Math.max(1, (Date.now() - createdAt) / 36e5);
  const engagement = views + likes * 8 + comments * 12;
  const trending = Math.round((engagement / Math.pow(ageHours + 2, 1.15)) * 100) / 100;
  return { engagementScore: engagement, trendingScore: trending };
}

export function rowToSearchDoc(row = {}) {
  const id = String(row.video_id || row.videoId || row.id || '');
  const iframeEmbed = text(row.iframe_embed || row.iframeEmbed);
  const playbackType = importedPlaybackType(row);
  const sourcePageUrl = text(row.video_url || row.videoUrl || row.page_url || row.pageUrl || row.external_url || row.externalUrl || row.url);
  const rawPlaybackUrl = text(row.playback_url || row.playbackUrl || row.stream_url || row.streamUrl || row.storage_url || row.storageUrl || row.embed_url || row.embedUrl);
  const directPlaybackUrl = isDirectPlayableStreamUrl(rawPlaybackUrl, { allowUnapprovedDirectHost: allowsImportedDirectHost(row) })
    ? rawPlaybackUrl
    : '';
  const isExternalEmbed = !directPlaybackUrl && (playbackType.toLowerCase() === 'external_embed' || iframeEmbed.length > 0);
  const effectivePlaybackType = directPlaybackUrl ? 'internal' : playbackType;
  const playbackUrl = isExternalEmbed ? '' : (directPlaybackUrl || rawPlaybackUrl || sourcePageUrl);
  const tokenPrice = Number(row.token_price ?? row.tokenPrice ?? row.coin_price ?? 0);
  const rawAccessType = text(row.access_type || row.accessType).replace(/-/g, '_')
    || (row.requires_membership === true || row.requiresMembership === true
      ? 'coin_unlock'
      : tokenPrice > 0
        ? 'coin_unlock'
        : (row.is_premium_content === true || row.isPremiumContent === true ? 'premium' : 'free'));
  const legacyCoinGate = row.requires_membership === true || row.requiresMembership === true || row.subscription_access === true || row.subscriptionAccess === true || rawAccessType === 'members_only';
  const accessType = legacyCoinGate ? 'coin_unlock' : rawAccessType;
  const tags = normalizeArray(row.tags);
  const categories = normalizeArray(row.categories || row.main_orientation_category || row.category);
  const scores = scoreVideo(row);
  return {
    id,
    videoId: id,
    title: text(row.title, 'Video'),
    description: text(row.description || row.desc),
    tags,
    categories,
    category: categories[0] || '',
    creatorId: row.creator_id || row.creatorId || row.user_id || row.userId || null,
    creatorDisplayName: text(row.creator_display_name || row.creatorDisplayName || row.channelName),
    creatorAvatarUrl: row.creator_avatar_url || row.creatorAvatarUrl || null,
    provider: text(row.provider),
    thumbnailUrl: row.thumbnail_url || row.thumbnailUrl || row.thumbnail || row.poster_url || row.posterUrl || row.poster || row.thumb_url || row.thumbUrl || row.thumb || '',
    duration: Number(row.duration_seconds ?? row.duration ?? 0),
    videoUrl: sourcePageUrl || playbackUrl,
    playbackUrl,
    streamUrl: directPlaybackUrl || (isExternalEmbed ? '' : playbackUrl),
    embedUrl: row.embed_url || row.embedUrl || '',
    iframeEmbed,
    iframe_embed: iframeEmbed,
    playbackType: effectivePlaybackType,
    playback_type: effectivePlaybackType,
    isPremiumContent:
      row.is_premium_content === true ||
      row.isPremiumContent === true ||
      tokenPrice > 0 ||
      ['premium', 'coin_unlock'].includes(accessType) ||
      legacyCoinGate,
    tokenPrice,
    accessType,
    premiumVisibility: row.premium_visibility || row.premiumVisibility || (accessType === 'free' ? 'public' : 'public_preview'),
    requiresMembership: false,
    subscriptionAccess: false,
    officialCompanyContent: row.official_company_content === true || row.officialCompanyContent === true,
    contentSource: text(row.content_source || row.contentSource || (row.import_job_id || iframeEmbed ? 'imported_csv' : ''), 'creator'),
    playable: isExternalEmbed ? true : row.playable !== false,
    deleted: Boolean(row.deleted_at || row.deleted || (row.is_live !== true && row.status !== 'published')),
    viewsCount: Number(row.views_count ?? row.viewsCount ?? 0),
    likesCount: Number(row.likes_count ?? row.likesCount ?? 0),
    commentsCount: Number(row.comments_count ?? row.commentsCount ?? 0),
    createdAt: timestamp(row.created_at || row.createdAt),
    updatedAt: timestamp(row.updated_at || row.updatedAt || row.created_at || row.createdAt),
    ...scores,
  };
}

function creatorToDoc(row = {}, user = null) {
  const id = String(row.user_id || row.userId || row.id || user?.id || '');
  const displayName = text(row.display_name || row.displayName || user?.display_name || user?.username || user?.email, 'Creator');
  const followers = Number(user?.followers ?? row.followers ?? 0);
  const totalViews = Number(row.total_views ?? row.totalViews ?? 0);
  const totalLikes = Number(row.total_likes ?? row.totalLikes ?? 0);
  return {
    id,
    creatorId: id,
    displayName,
    username: text(user?.username || row.username),
    bio: text(row.bio || user?.bio),
    avatarUrl: row.avatar_url || row.avatar || user?.avatar_url || user?.avatar || null,
    creatorType: text(row.creator_type || row.creatorType, 'pstar'),
    active: row.active !== false && row.status !== 'suspended',
    status: text(row.status, 'active'),
    verified: user?.verified === true || user?.creator === true || row.verified === true,
    followers,
    totalViews,
    totalLikes,
    popularityScore: followers * 3 + totalViews + totalLikes * 8,
    createdAt: timestamp(row.created_at || user?.created_at),
    updatedAt: timestamp(row.updated_at || user?.updated_at || row.created_at || user?.created_at),
    tags: normalizeArray(row.tags || row.categories),
  };
}

function userToDoc(row = {}) {
  const id = String(row.id || row.user_id || '');
  return {
    id,
    displayName: text(row.display_name || row.full_name || row.username || row.email, 'User'),
    username: text(row.username),
    email: text(row.email),
    avatarUrl: row.avatar_url || row.avatar || null,
    role: text(row.role, row.creator ? 'creator' : 'user'),
    status: text(row.account_status || row.status, 'active'),
    creator: row.creator === true,
    verified: row.verified === true || row.email_verified === true,
    followers: Number(row.followers || 0),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at || row.created_at),
  };
}

function liveToDoc(row = {}) {
  const id = String(row.id || '');
  const viewers = Number(row.viewers_count || row.viewersCount || 0);
  const likes = Number(row.total_likes || row.totalLikes || 0);
  const gifts = Number(row.total_gifts_amount || row.totalGiftsAmount || 0);
  return {
    id,
    title: text(row.title || row.host_display_name || row.hostDisplayName, 'Live stream'),
    hostId: row.host_id || row.hostId || row.user_id || row.userId || null,
    hostDisplayName: text(row.host_display_name || row.hostDisplayName || row.title),
    status: text(row.status, 'live'),
    viewersCount: viewers,
    totalLikes: likes,
    totalGiftsAmount: gifts,
    trendingScore: viewers * 10 + likes + gifts * 4,
    createdAt: timestamp(row.created_at || row.started_at),
    startedAt: timestamp(row.started_at || row.created_at),
    endedAt: row.ended_at ? timestamp(row.ended_at) : null,
  };
}

function taxonomyDoc(name, type, count = 1) {
  const normalizedName = normalizeName(name);
  return {
    id: `${type}:${normalizedName}`,
    name: text(name),
    normalizedName,
    type,
    count: Number(count || 1),
    trendingScore: Number(count || 1),
    updatedAt: Date.now(),
  };
}

const REINDEX_TARGETS = {
  videos: { table: 'tiktok_videos', indexName: MEILI_INDEXES.videos },
  creators: { table: 'creators', indexName: MEILI_INDEXES.creators },
  users: { table: 'users', indexName: MEILI_INDEXES.users },
  live_streams: { table: 'lives', indexName: MEILI_INDEXES.liveStreams },
  taxonomies: { table: 'tiktok_videos', indexName: `${MEILI_INDEXES.tags},${MEILI_INDEXES.categories}` },
};

function resolveReindexTargets(target = 'all') {
  const normalized = String(target || 'all').trim().toLowerCase();
  if (normalized === 'all') return ['videos', 'creators', 'users', 'live_streams', 'taxonomies'];
  if (normalized === 'live') return ['live_streams'];
  if (normalized === 'tags' || normalized === 'categories') return ['taxonomies'];
  if (!REINDEX_TARGETS[normalized]) throw new Error(`Unsupported reindex target: ${target}`);
  return [normalized];
}

function applyTargetFilter(target, query) {
  if (target === 'videos' || target === 'taxonomies') {
    return query.is('deleted_at', null).or('is_live.eq.true,status.eq.published');
  }
  if (target === 'live_streams') {
    return query.in('status', ['live', 'paused']);
  }
  return query;
}

function nextRetryAt(attempts) {
  const delay = Math.min(30 * 60_000, INDEXING_RETRY_BASE_DELAY_MS * Math.max(1, 2 ** Math.max(0, attempts - 1)));
  return new Date(Date.now() + delay).toISOString();
}

function memoryStats() {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(usage.heapTotal / 1024 / 1024),
    systemFreeMb: Math.round(os.freemem() / 1024 / 1024),
    systemTotalMb: Math.round(os.totalmem() / 1024 / 1024),
  };
}

function docToHomeCard(doc) {
  const iframeEmbed = doc.iframeEmbed || doc.iframe_embed || '';
  const explicitPlaybackType = String(doc.playbackType || doc.playback_type || '').trim().toLowerCase();
  const playbackType = explicitPlaybackType === 'internal'
    ? 'internal'
    : iframeEmbed ? 'external_embed' : explicitPlaybackType;
  const card = publicVideoToHomeCard({
    id: doc.id,
    videoId: doc.id,
    title: doc.title,
    thumbnailUrl: doc.thumbnailUrl,
    durationSeconds: doc.duration,
    streamUrl: doc.streamUrl || doc.playbackUrl,
    videoUrl: doc.videoUrl,
    playbackUrl: doc.playbackUrl,
    iframeEmbed,
    iframe_embed: iframeEmbed,
    playbackType,
    playback_type: playbackType,
    creatorDisplayName: doc.creatorDisplayName,
    userId: doc.creatorId || doc.userId,
    isPremiumContent: doc.isPremiumContent,
    tokenPrice: doc.tokenPrice,
    accessType: doc.accessType,
    premiumVisibility: doc.premiumVisibility,
    requiresMembership: doc.requiresMembership,
    subscriptionAccess: doc.subscriptionAccess,
    officialCompanyContent: doc.officialCompanyContent,
    tags: doc.tags,
    category: doc.categories?.[0] || doc.category || '',
    source: ['imported', 'imported_csv', 'official_import'].includes(String(doc.contentSource || '').toLowerCase())
      ? 'imported_csv'
      : 'community',
    contentSource: doc.contentSource,
    sourceType: playbackType === 'external_embed' ? 'external_embed' : '',
    embedAllowed: playbackType === 'external_embed' && Boolean(iframeEmbed),
    playable: doc.playable !== false,
  }, 0);
  return card ? annotatePlayableVideo(card) : null;
}

function cacheKey(name, payload) {
  return `${name}:${JSON.stringify(payload)}`;
}

function getCached(key) {
  const hit = searchCache.get(key);
  if (!hit || Date.now() - hit.ts > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value) {
  searchCache.set(key, { ts: Date.now(), value });
  if (searchCache.size > 200) {
    const first = searchCache.keys().next().value;
    if (first) searchCache.delete(first);
  }
}

async function safeSelect(table, select = '*', builder = null) {
  if (!supabase) return [];
  try {
    let query = supabase.from(table).select(select);
    if (builder) query = builder(query);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (err) {
    if (isMissingFeature(err)) return [];
    throw err;
  }
}

async function addDocuments(indexName, docs) {
  const ms = getMeilisearchClient();
  const filtered = (docs || []).filter((doc) => doc?.id);
  if (!ms || filtered.length === 0) return { indexed: 0 };
  await ensureIndex(indexName);
  const task = await ms.index(indexName).addDocuments(filtered);
  return { indexed: filtered.length, taskUid: task?.taskUid ?? task?.uid };
}

async function addDocumentsInChunks(indexName, docs) {
  let indexed = 0;
  const filtered = (docs || []).filter((doc) => doc?.id);
  for (let i = 0; i < filtered.length; i += MEILI_DOCUMENT_BATCH_SIZE) {
    const result = await addDocuments(indexName, filtered.slice(i, i + MEILI_DOCUMENT_BATCH_SIZE));
    indexed += Number(result.indexed || 0);
  }
  return { indexed };
}

async function deleteDocument(indexName, id) {
  const ms = getMeilisearchClient();
  if (!ms || !id) return { deleted: false };
  await ensureIndex(indexName);
  try {
    await ms.index(indexName).deleteDocument(String(id));
    return { deleted: true };
  } catch {
    return { deleted: false };
  }
}

async function deleteDocuments(indexName, ids) {
  const ms = getMeilisearchClient();
  const list = [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
  if (!ms || !indexName || !list.length) return { deleted: 0 };
  await ensureIndex(indexName);
  for (let i = 0; i < list.length; i += MEILI_DOCUMENT_BATCH_SIZE) {
    await ms.index(indexName).deleteDocuments(list.slice(i, i + MEILI_DOCUMENT_BATCH_SIZE));
  }
  return { deleted: list.length };
}

export async function searchPostgres(q, { page = 1, limit = 20, filters = {} } = {}) {
  if (!supabase) return { items: [], total: 0, hasMore: false };
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const offset = (pageNum - 1) * limitNum;
  const term = String(q || '').trim();

  let query = supabase
    .from('tiktok_videos')
    .select('*', { count: 'exact' })
    .is('deleted_at', null)
    .or('is_live.eq.true,status.eq.published')
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (filters.premium === true) query = query.eq('is_premium_content', true);
  if (filters.contentSource) query = query.eq('content_source', filters.contentSource);

  if (term) {
    const escaped = term.replace(/[%_]/g, '');
    query = query.or(`title.ilike.%${escaped}%,description.ilike.%${escaped}%,creator_display_name.ilike.%${escaped}%`);
  }

  const { data, error, count } = await query;
  if (error) {
    if (isMissingFeature(error)) {
      let fallback = supabase.from('tiktok_videos').select('*').order('created_at', { ascending: false }).range(offset, offset + limitNum - 1);
      if (term) fallback = fallback.ilike('title', `%${term}%`);
      const retry = await fallback;
      if (retry.error) return { items: [], total: 0, hasMore: false };
      const items = (retry.data || []).map(rowToSearchDoc).map(docToHomeCard).filter(Boolean);
      return { items, total: items.length, hasMore: items.length >= limitNum };
    }
    throw error;
  }

  const items = (data || []).map(rowToSearchDoc).map(docToHomeCard).filter(Boolean);
  const total = Number(count) || items.length;
  return { items, total, hasMore: offset + items.length < total };
}

export async function searchMeilisearch(q, { page = 1, limit = 20, filters = {}, sort = null } = {}) {
  const ms = getMeilisearchClient();
  if (!ms) return null;
  await ensureVideosIndex();
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const offset = (pageNum - 1) * limitNum;
  const filterParts = ['deleted = false'];
  if (filters.premium === true) filterParts.push('isPremiumContent = true');
  if (filters.contentSource) filterParts.push(`contentSource = "${String(filters.contentSource).replace(/"/g, '\\"')}"`);

  const searchOptions = {
    limit: limitNum,
    offset,
    filter: filterParts.join(' AND '),
  };
  if (sort) searchOptions.sort = [sort];

  const result = await ms.index(VIDEOS_INDEX).search(String(q || '').trim(), searchOptions);

  const items = (result.hits || []).map(docToHomeCard).filter(Boolean);
  const total = Number(result.estimatedTotalHits ?? result.totalHits ?? items.length);
  return { items, total, hasMore: offset + items.length < total };
}

export async function searchPlatformVideos(q, options = {}) {
  const key = cacheKey('videos', { q, page: options.page, limit: options.limit, filters: options.filters, sort: options.sort });
  const cached = getCached(key);
  if (cached) return cached;

  const meili = await searchMeilisearch(q, options).catch(() => null);
  const result = meili && meili.items.length > 0
    ? meili
    : await searchPostgres(q, options);

  if (q && supabase) {
    runOptionalSupabaseQuery(
      supabase.from('video_search_queries').insert({
        query: String(q).slice(0, 200),
        result_count: result.items.length,
        user_id: options.userId || null,
      }),
      'record search query',
    );
  }

  setCached(key, result);
  return result;
}

export async function searchAllContent(q, { limit = 6, includeUsers = false } = {}) {
  const ms = getMeilisearchClient();
  const query = String(q || '').trim();
  if (!ms || !query) {
    return { videos: [], creators: [], users: [], liveStreams: [], tags: [], categories: [] };
  }
  await ensureAllIndexes();

  const [videos, creators, users, liveStreams, tags, categories] = await Promise.all([
    ms.index(MEILI_INDEXES.videos).search(query, { limit, filter: 'deleted = false' }).catch(() => ({ hits: [] })),
    ms.index(MEILI_INDEXES.creators).search(query, { limit, filter: 'active = true' }).catch(() => ({ hits: [] })),
    includeUsers ? ms.index(MEILI_INDEXES.users).search(query, { limit }).catch(() => ({ hits: [] })) : Promise.resolve({ hits: [] }),
    ms.index(MEILI_INDEXES.liveStreams).search(query, { limit, filter: 'status IN ["live", "paused"]' }).catch(() => ({ hits: [] })),
    ms.index(MEILI_INDEXES.tags).search(query, { limit, sort: ['trendingScore:desc'] }).catch(() => ({ hits: [] })),
    ms.index(MEILI_INDEXES.categories).search(query, { limit, sort: ['trendingScore:desc'] }).catch(() => ({ hits: [] })),
  ]);

  return {
    videos: (videos.hits || []).map(docToHomeCard).filter(Boolean),
    creators: creators.hits || [],
    users: users.hits || [],
    liveStreams: liveStreams.hits || [],
    tags: tags.hits || [],
    categories: categories.hits || [],
  };
}

export async function autocompleteSearch(q, limit = 8) {
  const query = String(q || '').trim();
  const suggestions = [];
  if (query && isMeilisearchConfigured()) {
    const results = await searchAllContent(query, { limit: Math.max(3, Math.ceil(limit / 2)), includeUsers: false }).catch(() => null);
    for (const item of results?.videos || []) suggestions.push({ type: 'video', label: item.title, value: item.title, id: item.id, thumbnailUrl: item.thumbnailUrl });
    for (const item of results?.creators || []) suggestions.push({ type: 'creator', label: item.displayName, value: item.displayName, id: item.id, avatarUrl: item.avatarUrl });
    for (const item of results?.liveStreams || []) suggestions.push({ type: 'live_stream', label: item.title, value: item.title, id: item.id });
    for (const item of results?.tags || []) suggestions.push({ type: 'tag', label: item.name, value: item.name, id: item.id });
    for (const item of results?.categories || []) suggestions.push({ type: 'category', label: item.name, value: item.name, id: item.id });
  }

  if (suggestions.length < limit) {
    const queries = query ? await suggestSearchQueries(query, limit) : await getTrendingSearchQueries(limit);
    for (const term of queries) suggestions.push({ type: 'query', label: term, value: term });
  }

  const seen = new Set();
  return suggestions.filter((item) => {
    const key = `${item.type}:${String(item.value || item.label).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return item.label;
  }).slice(0, limit);
}

export async function suggestSearchQueries(q, limit = 8) {
  const prefix = String(q || '').trim().toLowerCase();
  if (!prefix || !supabase) return [];
  const { data } = await supabase
    .from('video_search_queries')
    .select('query')
    .ilike('query', `${prefix}%`)
    .order('created_at', { ascending: false })
    .limit(limit * 3);
  const seen = new Set();
  const out = [];
  for (const row of data || []) {
    const query = String(row.query || '').trim();
    if (!query || seen.has(query.toLowerCase())) continue;
    seen.add(query.toLowerCase());
    out.push(query);
    if (out.length >= limit) break;
  }
  return out;
}

export async function getTrendingSearchQueries(limit = 10) {
  if (!supabase) return [];
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data } = await supabase
    .from('video_search_queries')
    .select('query')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);
  const counts = new Map();
  for (const row of data || []) {
    const q = String(row.query || '').trim().toLowerCase();
    if (!q || q.length < 2) continue;
    counts.set(q, (counts.get(q) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([query]) => query);
}

async function updateVideoTaxonomies(doc) {
  const tagCounts = new Map();
  const categoryCounts = new Map();
  for (const tag of doc.tags || []) tagCounts.set(tag, 1);
  for (const category of doc.categories || []) categoryCounts.set(category, 1);
  await addDocuments(MEILI_INDEXES.tags, [...tagCounts.entries()].map(([name, count]) => taxonomyDoc(name, 'tag', count)));
  await addDocuments(MEILI_INDEXES.categories, [...categoryCounts.entries()].map(([name, count]) => taxonomyDoc(name, 'category', count)));
}

export async function indexVideoRow(row) {
  const doc = rowToSearchDoc(row);
  if (!doc.id) return { postgres: false, meili: false };
  if (doc.deleted || doc.playable === false) {
    await removeVideoFromIndex(doc.id);
    if (supabase) {
      await runOptionalSupabaseQuery(
        supabase.from('tiktok_videos').update({ is_indexed: false }).eq('video_id', doc.id),
        'mark deleted video unindexed',
      );
    }
    return { postgres: false, meili: true, deleted: true };
  }

  if (supabase) {
    await runOptionalSupabaseQuery(
      supabase.from('tiktok_videos').update({
        is_indexed: true,
      }).eq('video_id', doc.id),
      'mark video indexed',
    );
  }

  const ms = getMeilisearchClient();
  if (ms) {
    await addDocuments(MEILI_INDEXES.videos, [doc]);
    await updateVideoTaxonomies(doc).catch(() => {});
    if (supabase) {
      await runOptionalSupabaseQuery(
        supabase.from('tiktok_videos').update({ meili_synced_at: new Date().toISOString() }).eq('video_id', doc.id),
        'mark video meili synced',
      );
    }
    return { postgres: true, meili: true };
  }
  return { postgres: true, meili: false };
}

export async function indexCreatorRow(row, user = null) {
  const doc = creatorToDoc(row, user);
  if (!doc.id) return { meili: false };
  await addDocuments(MEILI_INDEXES.creators, [doc]);
  return { meili: true };
}

export async function indexUserRow(row) {
  const doc = userToDoc(row);
  if (!doc.id) return { meili: false };
  await addDocuments(MEILI_INDEXES.users, [doc]);
  if (doc.creator) await addDocuments(MEILI_INDEXES.creators, [creatorToDoc({}, row)]).catch(() => {});
  return { meili: true };
}

export async function indexLiveStreamRow(row) {
  const doc = liveToDoc(row);
  if (!doc.id) return { meili: false };
  await addDocuments(MEILI_INDEXES.liveStreams, [doc]);
  return { meili: true };
}

export async function removeVideoFromIndex(videoId) {
  return deleteDocument(MEILI_INDEXES.videos, videoId);
}

export async function removeSearchDocument(type, id) {
  const indexByType = {
    video: MEILI_INDEXES.videos,
    creator: MEILI_INDEXES.creators,
    user: MEILI_INDEXES.users,
    live_stream: MEILI_INDEXES.liveStreams,
    tag: MEILI_INDEXES.tags,
    category: MEILI_INDEXES.categories,
  };
  return deleteDocument(indexByType[type], id);
}

async function fetchObjectForQueue(type, objectId) {
  if (!supabase || !objectId) return null;
  if (type === 'video') {
    const { data } = await supabase.from('tiktok_videos').select('*').eq('video_id', objectId).maybeSingle();
    return data;
  }
  if (type === 'creator') {
    const { data: creator } = await supabase.from('creators').select('*').or(`user_id.eq.${objectId},id.eq.${objectId}`).limit(1).maybeSingle();
    const { data: user } = creator?.user_id ? await supabase.from('users').select('*').eq('id', creator.user_id).maybeSingle() : { data: null };
    return { creator, user };
  }
  if (type === 'user') {
    const { data } = await supabase.from('users').select('*').eq('id', objectId).maybeSingle();
    return data;
  }
  if (type === 'live_stream') {
    const { data } = await supabase.from('lives').select('*').eq('id', objectId).maybeSingle();
    return data;
  }
  return null;
}

async function processQueueRow(row) {
  const type = row.object_type || row.type || 'video';
  const objectId = row.object_id || row.video_id || row.target_id;
  const action = row.action || 'upsert';
  if (!INDEXABLE_TYPES.has(type)) throw new Error(`Unsupported index type: ${type}`);
  if (action === 'delete') {
    await removeSearchDocument(type, objectId);
    return;
  }
  const payload = await fetchObjectForQueue(type, objectId);
  if (type === 'video' && payload) await indexVideoRow(payload);
  else if (type === 'creator' && payload?.creator) await indexCreatorRow(payload.creator, payload.user);
  else if (type === 'user' && payload) await indexUserRow(payload);
  else if (type === 'live_stream' && payload) await indexLiveStreamRow(payload);
}

async function fetchRowsByIds(table, column, ids) {
  const out = [];
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  for (let i = 0; i < list.length; i += MEILI_DOCUMENT_BATCH_SIZE) {
    const { data, error } = await supabase.from(table).select('*').in(column, list.slice(i, i + MEILI_DOCUMENT_BATCH_SIZE));
    if (error) {
      if (isMissingFeature(error)) return out;
      throw error;
    }
    out.push(...(data || []));
  }
  return out;
}

async function processQueueGroup(type, action, rows) {
  const ids = rows.map((row) => row.object_id || row.video_id || row.target_id).map(String).filter(Boolean);
  if (!ids.length) return { processed: 0, indexed: 0, deleted: 0 };

  const indexByType = {
    video: MEILI_INDEXES.videos,
    creator: MEILI_INDEXES.creators,
    user: MEILI_INDEXES.users,
    live_stream: MEILI_INDEXES.liveStreams,
    tag: MEILI_INDEXES.tags,
    category: MEILI_INDEXES.categories,
  };

  if (action === 'delete') {
    const result = await deleteDocuments(indexByType[type], ids);
    return { processed: rows.length, indexed: 0, deleted: result.deleted || 0 };
  }

  if (type === 'video') {
    const videoRows = await fetchRowsByIds('tiktok_videos', 'video_id', ids);
    const found = new Set(videoRows.map((row) => String(row.video_id)));
    const docs = [];
    const deleteIds = ids.filter((id) => !found.has(String(id)));
    for (const row of videoRows) {
      const doc = rowToSearchDoc(row);
      if (!doc.id) continue;
      if (doc.deleted || doc.playable === false) deleteIds.push(doc.id);
      else docs.push(doc);
    }
    const indexed = await addDocumentsInChunks(MEILI_INDEXES.videos, docs);
    const deleted = await deleteDocuments(MEILI_INDEXES.videos, deleteIds);
    if (docs.length) {
      const indexedIds = docs.map((doc) => doc.id);
      for (let i = 0; i < indexedIds.length; i += MEILI_DOCUMENT_BATCH_SIZE) {
        await runOptionalSupabaseQuery(
          supabase.from('tiktok_videos').update({
            is_indexed: true,
            meili_synced_at: new Date().toISOString(),
          }).in('video_id', indexedIds.slice(i, i + MEILI_DOCUMENT_BATCH_SIZE)),
          'mark queued videos indexed',
        );
      }
    }
    for (const doc of docs) await updateVideoTaxonomies(doc).catch(() => {});
    return { processed: rows.length, indexed: indexed.indexed || 0, deleted: deleted.deleted || 0 };
  }

  if (type === 'creator') {
    const creatorRows = await fetchRowsByIds('creators', 'user_id', ids);
    const foundCreatorKeys = new Set(creatorRows.flatMap((row) => [String(row.user_id || ''), String(row.id || '')]).filter(Boolean));
    const missingCreatorIds = ids.filter((id) => !foundCreatorKeys.has(String(id)));
    if (missingCreatorIds.length) {
      creatorRows.push(...await fetchRowsByIds('creators', 'id', missingCreatorIds));
    }
    const userIds = [...new Set(creatorRows.map((row) => String(row.user_id || '')).filter(Boolean))];
    const users = userIds.length ? await fetchRowsByIds('users', 'id', userIds) : [];
    const usersById = new Map(users.map((user) => [String(user.id), user]));
    const docs = creatorRows.map((row) => creatorToDoc(row, usersById.get(String(row.user_id)))).filter((doc) => doc.id);
    const indexed = await addDocumentsInChunks(MEILI_INDEXES.creators, docs);
    const found = new Set(docs.map((doc) => String(doc.id)));
    const deleted = await deleteDocuments(MEILI_INDEXES.creators, ids.filter((id) => !found.has(String(id))));
    return { processed: rows.length, indexed: indexed.indexed || 0, deleted: deleted.deleted || 0 };
  }

  if (type === 'user') {
    const userRows = await fetchRowsByIds('users', 'id', ids);
    const docs = userRows.map(userToDoc).filter((doc) => doc.id);
    const creatorDocs = userRows.filter((row) => row.creator === true).map((row) => creatorToDoc({}, row)).filter((doc) => doc.id);
    const usersIndexed = await addDocumentsInChunks(MEILI_INDEXES.users, docs);
    const creatorsIndexed = await addDocumentsInChunks(MEILI_INDEXES.creators, creatorDocs);
    const found = new Set(docs.map((doc) => String(doc.id)));
    const deleted = await deleteDocuments(MEILI_INDEXES.users, ids.filter((id) => !found.has(String(id))));
    return { processed: rows.length, indexed: (usersIndexed.indexed || 0) + (creatorsIndexed.indexed || 0), deleted: deleted.deleted || 0 };
  }

  if (type === 'live_stream') {
    const liveRows = await fetchRowsByIds('lives', 'id', ids);
    const docs = liveRows.map(liveToDoc).filter((doc) => doc.id);
    const indexed = await addDocumentsInChunks(MEILI_INDEXES.liveStreams, docs);
    const found = new Set(docs.map((doc) => String(doc.id)));
    const deleted = await deleteDocuments(MEILI_INDEXES.liveStreams, ids.filter((id) => !found.has(String(id))));
    return { processed: rows.length, indexed: indexed.indexed || 0, deleted: deleted.deleted || 0 };
  }

  return { processed: 0, indexed: 0, deleted: 0 };
}

async function markQueueRowsProcessed(rows) {
  const ids = rows.map((row) => row.id).filter(Boolean);
  if (!ids.length) return;
  const result = await supabase.from('search_index_queue').update({
    status: 'completed',
    processed_at: new Date().toISOString(),
    error_message: null,
    locked_at: null,
    locked_by: null,
    updated_at: new Date().toISOString(),
  }).in('id', ids);
  if (!result?.error) return;
  if (isMissingFeature(result.error)) {
    await runOptionalSupabaseQuery(
      supabase.from('search_index_queue').update({ processed_at: new Date().toISOString() }).in('id', ids),
      'mark legacy queue rows processed',
    );
    return;
  }
  console.warn('[search-index] mark queue rows processed failed:', result.error.message || result.error);
}

async function deadLetterQueueRows(rows, err) {
  const message = String(err?.message || err || 'Index queue item failed').slice(0, 2000);
  for (const row of rows) {
    await runOptionalSupabaseQuery(
      supabase.from('search_index_dead_letters').insert({
        source: 'queue',
        source_id: row.id,
        target: row.object_type || 'video',
        action: row.action || 'upsert',
        attempts: Number(row.attempts || 0) + 1,
        error_message: message,
        payload: row,
      }),
      'write queue dead letter',
    );
  }
  const ids = rows.map((row) => row.id).filter(Boolean);
  await runOptionalSupabaseQuery(
    supabase.from('search_index_queue').update({
      status: 'dead',
      dead_letter_at: new Date().toISOString(),
      error_message: message,
      locked_at: null,
      locked_by: null,
      updated_at: new Date().toISOString(),
    }).in('id', ids),
    'mark queue rows dead',
  );
}

async function markQueueRowsFailed(rows, err) {
  const message = String(err?.message || err || 'Index queue item failed').slice(0, 2000);
  const deadRows = rows.filter((row) => Number(row.attempts || 0) + 1 >= INDEXING_MAX_RETRIES);
  const retryRows = rows.filter((row) => !deadRows.includes(row));
  if (deadRows.length) await deadLetterQueueRows(deadRows, err);
  for (const row of retryRows) {
    await runOptionalSupabaseQuery(
      supabase.from('search_index_queue').update({
        status: 'retrying',
        attempts: Number(row.attempts || 0) + 1,
        error_message: message,
        last_attempt_at: new Date().toISOString(),
        next_attempt_at: nextRetryAt(Number(row.attempts || 0) + 1),
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      }).eq('id', row.id),
      'mark queue row retrying',
    );
  }
}

export async function processSearchIndexQueue(batchSize = 100) {
  if (!supabase) return { processed: 0, failed: 0 };
  if (!INDEXING_QUEUE_ENABLED) return { processed: 0, failed: 0, skipped: true, reason: 'Indexing queue disabled' };
  if (await isIndexingPaused()) return { processed: 0, failed: 0, paused: true };
  if (!isMeilisearchConfigured()) {
    return { processed: 0, failed: 0, skipped: true, reason: 'Meilisearch is not configured' };
  }
  const workerId = `${process.pid}:${randomUUID()}`;
  let query = supabase
    .from('search_index_queue')
    .select('*')
    .is('processed_at', null)
    .is('dead_letter_at', null)
    .order('created_at', { ascending: true })
    .limit(Math.max(batchSize * 3, batchSize));
  let { data: rows, error } = await query;
  if (error) {
    if (!isMissingFeature(error)) throw error;
    const fallback = await supabase.from('search_index_queue').select('*').is('processed_at', null).order('created_at', { ascending: true }).limit(batchSize);
    rows = fallback.data || [];
    error = fallback.error;
    if (error) {
      if (isMissingFeature(error)) return { processed: 0, failed: 0 };
      throw error;
    }
  }

  let processed = 0;
  let failed = 0;
  let indexed = 0;
  let deleted = 0;
  const ready = (rows || [])
    .filter((row) => !row.next_attempt_at || new Date(row.next_attempt_at).getTime() <= Date.now())
    .slice(0, Math.max(1, Number(batchSize) || 100));

  const grouped = new Map();
  for (const row of ready) {
    const type = row.object_type || row.type || 'video';
    const action = row.action || 'upsert';
    const key = `${type}:${action}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ...row, locked_by: workerId });
  }

  for (const groupRows of grouped.values()) {
    try {
      const type = groupRows[0].object_type || groupRows[0].type || 'video';
      const action = groupRows[0].action || 'upsert';
      let result;
      if (groupRows.length === 1 && !groupRows[0].object_type) {
        await processQueueRow(groupRows[0]);
        result = { processed: 1, indexed: 1, deleted: action === 'delete' ? 1 : 0 };
      } else {
        result = await processQueueGroup(type, action, groupRows);
      }
      await markQueueRowsProcessed(groupRows);
      processed += result.processed || groupRows.length;
      indexed += result.indexed || 0;
      deleted += result.deleted || 0;
    } catch (err) {
      failed += groupRows.length;
      await markQueueRowsFailed(groupRows, err);
    }
  }
  if (processed || failed) searchCache.clear();
  return { processed, failed, indexed, deleted };
}

export async function enqueueSearchDocument(type, objectId, action = 'upsert') {
  if (!supabase || !objectId) return;
  const { error } = await supabase.from('search_index_queue').insert({
    object_type: type,
    object_id: String(objectId),
    video_id: type === 'video' ? String(objectId) : String(objectId),
    action,
  });
  if (!error) return;
  if (!isMissingFeature(error)) throw error;
  if (type === 'video') {
    await runOptionalSupabaseQuery(
      supabase.from('search_index_queue').insert({ video_id: String(objectId), action }),
      'enqueue legacy video search document',
    );
  }
}

export async function enqueueSearchIndex(videoId, action = 'upsert') {
  return enqueueSearchDocument('video', videoId, action);
}

async function countTargetRows(target) {
  const config = REINDEX_TARGETS[target];
  if (!supabase || !config) return 0;
  try {
    const { count, error } = await applyTargetFilter(
      target,
      supabase.from(config.table).select('*', { count: 'exact', head: true }),
    );
    if (error) throw error;
    return Number(count || 0);
  } catch (err) {
    if (isMissingFeature(err)) return 0;
    throw err;
  }
}

async function insertBatchRows(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('search_index_batches').insert(rows.slice(i, i + 500));
    if (error) throw error;
  }
}

export async function enqueueSearchReindex(target = 'all', { startedBy = null, batchSize = REINDEX_BATCH_SIZE } = {}) {
  if (!supabase) throw new Error('Database unavailable');
  if (!INDEXING_QUEUE_ENABLED) throw new Error('Indexing queue is disabled');
  if (!isMeilisearchConfigured()) throw new Error('Meilisearch is not configured');

  const targets = resolveReindexTargets(target);
  const safeBatchSize = Math.min(IMPORT_BATCH_SIZE, Math.max(100, Number(batchSize) || REINDEX_BATCH_SIZE));
  const counts = {};
  let totalEstimated = 0;
  for (const item of targets) {
    counts[item] = await countTargetRows(item);
    totalEstimated += counts[item];
  }

  const { data: run, error: runError } = await supabase.from('search_sync_runs').insert({
    status: totalEstimated > 0 ? 'queued' : 'completed',
    action: `reindex:${target}`,
    started_by: startedBy,
    stats: {
      target,
      targets,
      counts,
      totalEstimated,
      batchSize: safeBatchSize,
      documentBatchSize: MEILI_DOCUMENT_BATCH_SIZE,
      maxWorkers: MAX_CONCURRENT_INDEX_WORKERS,
      queuedBatches: totalEstimated ? targets.reduce((sum, item) => sum + Math.ceil((counts[item] || 0) / safeBatchSize), 0) : 0,
    },
    completed_at: totalEstimated > 0 ? null : new Date().toISOString(),
  }).select('*').single();
  if (runError) throw runError;

  const rows = [];
  for (const item of targets) {
    const config = REINDEX_TARGETS[item];
    const count = counts[item] || 0;
    const batchCount = Math.ceil(count / safeBatchSize);
    for (let batchNo = 0; batchNo < batchCount; batchNo += 1) {
      rows.push({
        run_id: run.id,
        target: item,
        index_name: config.indexName,
        table_name: config.table,
        status: 'pending',
        batch_no: batchNo,
        cursor_offset: batchNo * safeBatchSize,
        batch_size: safeBatchSize,
        total_estimated: count,
        max_attempts: INDEXING_MAX_RETRIES,
        metadata: { requestedTarget: target },
      });
    }
  }
  if (rows.length) await insertBatchRows(rows);
  searchCache.clear();
  return { runId: run.id, target, targets, totalEstimated, batchCount: rows.length, batchSize: safeBatchSize };
}

async function fetchRowsForBatch(batch) {
  const target = batch.target;
  const config = REINDEX_TARGETS[target];
  if (!supabase || !config) return [];
  const start = Number(batch.cursor_offset || 0);
  const size = Math.min(IMPORT_BATCH_SIZE, Math.max(1, Number(batch.batch_size || REINDEX_BATCH_SIZE)));
  let query = supabase.from(config.table).select('*').range(start, start + size - 1);
  query = applyTargetFilter(target, query);
  const { data, error } = await query;
  if (error) {
    if (isMissingFeature(error)) return [];
    throw error;
  }
  return data || [];
}

async function docsForBatch(target, rows) {
  if (target === 'videos') {
    const docs = [];
    const deleteIds = [];
    for (const row of rows) {
      const doc = rowToSearchDoc(row);
      if (!doc.id) continue;
      if (doc.deleted || doc.playable === false) deleteIds.push(doc.id);
      else docs.push(doc);
    }
    return { docsByIndex: { [MEILI_INDEXES.videos]: docs }, deleteByIndex: { [MEILI_INDEXES.videos]: deleteIds } };
  }

  if (target === 'creators') {
    const userIds = [...new Set(rows.map((row) => String(row.user_id || '')).filter(Boolean))];
    const users = userIds.length ? await safeSelect('users', '*', (query) => query.in('id', userIds)) : [];
    const usersById = new Map(users.map((user) => [String(user.id), user]));
    return {
      docsByIndex: {
        [MEILI_INDEXES.creators]: rows.map((row) => creatorToDoc(row, usersById.get(String(row.user_id)))).filter((doc) => doc.id),
      },
      deleteByIndex: {},
    };
  }

  if (target === 'users') {
    const userDocs = rows.map(userToDoc).filter((doc) => doc.id);
    const creatorDocs = rows.filter((row) => row.creator === true).map((row) => creatorToDoc({}, row)).filter((doc) => doc.id);
    return {
      docsByIndex: {
        [MEILI_INDEXES.users]: userDocs,
        [MEILI_INDEXES.creators]: creatorDocs,
      },
      deleteByIndex: {},
    };
  }

  if (target === 'live_streams') {
    return {
      docsByIndex: { [MEILI_INDEXES.liveStreams]: rows.map(liveToDoc).filter((doc) => doc.id) },
      deleteByIndex: {},
    };
  }

  if (target === 'taxonomies') {
    const tagCounts = new Map();
    const categoryCounts = new Map();
    for (const row of rows) {
      for (const tag of normalizeArray(row.tags)) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      for (const category of normalizeArray(row.categories || row.main_orientation_category || row.category)) {
        categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      }
    }
    return {
      docsByIndex: {
        [MEILI_INDEXES.tags]: [...tagCounts.entries()].map(([name, count]) => taxonomyDoc(name, 'tag', count)),
        [MEILI_INDEXES.categories]: [...categoryCounts.entries()].map(([name, count]) => taxonomyDoc(name, 'category', count)),
      },
      deleteByIndex: {},
    };
  }

  return { docsByIndex: {}, deleteByIndex: {} };
}

async function markRunIfFinished(runId) {
  if (!supabase || !runId) return;
  const { data: batches, error } = await supabase
    .from('search_index_batches')
    .select('status,processed_count,indexed_count,deleted_count,attempts,error_message')
    .eq('run_id', runId);
  if (error || !batches?.length) return;
  const unfinished = batches.filter((batch) => !['completed', 'dead'].includes(batch.status));
  if (unfinished.length) return;
  const dead = batches.filter((batch) => batch.status === 'dead');
  await runOptionalSupabaseQuery(
    supabase.from('search_sync_runs').update({
      status: dead.length ? 'failed' : 'completed',
      completed_at: new Date().toISOString(),
      stats: {
        totalBatches: batches.length,
        deadBatches: dead.length,
        processed: batches.reduce((sum, batch) => sum + Number(batch.processed_count || 0), 0),
        indexed: batches.reduce((sum, batch) => sum + Number(batch.indexed_count || 0), 0),
        deleted: batches.reduce((sum, batch) => sum + Number(batch.deleted_count || 0), 0),
        attempts: batches.reduce((sum, batch) => sum + Number(batch.attempts || 0), 0),
      },
    }).eq('id', runId),
    'mark search sync run finished',
  );
}

async function deadLetterBatch(batch, err) {
  const message = String(err?.message || err || 'Indexing batch failed').slice(0, 2000);
  await runOptionalSupabaseQuery(
    supabase.from('search_index_dead_letters').insert({
      source: 'batch',
      source_id: batch.id,
      run_id: batch.run_id,
      batch_id: batch.id,
      target: batch.target,
      attempts: Number(batch.attempts || 0),
      error_message: message,
      payload: batch,
    }),
    'write batch dead letter',
  );
  await supabase.from('search_index_batches').update({
    status: 'dead',
    locked_at: null,
    locked_by: null,
    error_message: message,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', batch.id);
  await markRunIfFinished(batch.run_id);
}

async function processSearchIndexBatch(batch) {
  if (!isMeilisearchConfigured()) throw new Error('Meilisearch is not configured');
  await ensureAllIndexes();
  if (batch.run_id) {
    await runOptionalSupabaseQuery(
      supabase.from('search_sync_runs').update({ status: 'running' }).eq('id', batch.run_id),
      'mark search sync run running',
    );
  }

  try {
    const rows = await fetchRowsForBatch(batch);
    const { docsByIndex, deleteByIndex } = await docsForBatch(batch.target, rows);
    let indexed = 0;
    let deleted = 0;

    for (const [indexName, ids] of Object.entries(deleteByIndex || {})) {
      const result = await deleteDocuments(indexName, ids);
      deleted += Number(result.deleted || 0);
    }

    for (const [indexName, docs] of Object.entries(docsByIndex || {})) {
      const result = await addDocumentsInChunks(indexName, docs);
      indexed += Number(result.indexed || 0);
    }

    if (batch.target === 'videos' && rows.length) {
      const ids = rows.map((row) => row.video_id).filter(Boolean);
      for (let i = 0; i < ids.length; i += MEILI_DOCUMENT_BATCH_SIZE) {
        await runOptionalSupabaseQuery(
          supabase.from('tiktok_videos').update({
            is_indexed: true,
            meili_synced_at: new Date().toISOString(),
          }).in('video_id', ids.slice(i, i + MEILI_DOCUMENT_BATCH_SIZE)),
          'mark batch videos indexed',
        );
      }
    }

    await supabase.from('search_index_batches').update({
      status: 'completed',
      processed_count: rows.length,
      indexed_count: indexed,
      deleted_count: deleted,
      locked_at: null,
      locked_by: null,
      error_message: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', batch.id);
    await markRunIfFinished(batch.run_id);
    searchCache.clear();
    return { batchId: batch.id, target: batch.target, processed: rows.length, indexed, deleted };
  } catch (err) {
    const attempts = Number(batch.attempts || 0);
    if (attempts >= Number(batch.max_attempts || INDEXING_MAX_RETRIES)) {
      await deadLetterBatch(batch, err);
      return { batchId: batch.id, failed: true, dead: true, error: err?.message || String(err) };
    }
    await supabase.from('search_index_batches').update({
      status: 'retrying',
      locked_at: null,
      locked_by: null,
      error_message: String(err?.message || err).slice(0, 2000),
      next_attempt_at: nextRetryAt(attempts),
      updated_at: new Date().toISOString(),
    }).eq('id', batch.id);
    return { batchId: batch.id, failed: true, retrying: true, error: err?.message || String(err) };
  }
}

async function recoverStaleSearchBatches() {
  if (!supabase) return 0;
  const staleBefore = new Date(Date.now() - INDEXING_LOCK_TIMEOUT_MS).toISOString();
  const { data } = await runOptionalSupabaseQuery(
    supabase
      .from('search_index_batches')
      .select('*')
      .eq('status', 'running')
      .lt('locked_at', staleBefore)
      .limit(100),
    'load stale search batches',
    { data: [] },
  );
  for (const batch of data || []) {
    await runOptionalSupabaseQuery(
      supabase.from('search_index_batches').update({
        status: 'retrying',
        locked_at: null,
        locked_by: null,
        next_attempt_at: new Date().toISOString(),
        error_message: 'Recovered stale indexing lock after worker interruption',
        updated_at: new Date().toISOString(),
      }).eq('id', batch.id),
      'recover stale search batch',
    );
  }
  return (data || []).length;
}

export async function isIndexingPaused() {
  if (!supabase) return indexingPausedFallback;
  try {
    const { data, error } = await supabase.from('search_index_control').select('paused').eq('id', 1).maybeSingle();
    if (error) throw error;
    indexingPausedFallback = Boolean(data?.paused);
    return indexingPausedFallback;
  } catch (err) {
    if (!isMissingFeature(err)) throw err;
    return indexingPausedFallback;
  }
}

export async function setIndexingPaused(paused, { reason = null, updatedBy = null } = {}) {
  indexingPausedFallback = Boolean(paused);
  if (!supabase) return { paused: indexingPausedFallback };
  try {
    const { data, error } = await supabase.from('search_index_control').upsert({
      id: 1,
      paused: indexingPausedFallback,
      paused_reason: reason,
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' }).select('*').single();
    if (error) throw error;
    return data;
  } catch (err) {
    if (isMissingFeature(err)) return { paused: indexingPausedFallback };
    throw err;
  }
}

async function claimSearchIndexBatches(limit = MAX_CONCURRENT_INDEX_WORKERS) {
  if (!supabase || !INDEXING_QUEUE_ENABLED || await isIndexingPaused()) return [];
  await recoverStaleSearchBatches().catch(() => 0);
  const now = new Date().toISOString();
  const workerId = `${process.pid}:${randomUUID()}`;
  const { data, error } = await supabase
    .from('search_index_batches')
    .select('*')
    .in('status', ['pending', 'retrying'])
    .order('created_at', { ascending: true })
    .limit(Math.max(limit * 3, limit));
  if (error) {
    if (isMissingFeature(error)) return [];
    throw error;
  }

  const claimed = [];
  for (const candidate of data || []) {
    if (claimed.length >= limit) break;
    if (candidate.next_attempt_at && new Date(candidate.next_attempt_at).getTime() > Date.now()) continue;
    const { data: row } = await supabase.from('search_index_batches').update({
      status: 'running',
      attempts: Number(candidate.attempts || 0) + 1,
      locked_at: now,
      locked_by: workerId,
      started_at: candidate.started_at || now,
      updated_at: now,
    }).eq('id', candidate.id).in('status', ['pending', 'retrying']).select('*').maybeSingle();
    if (row) claimed.push(row);
  }
  return claimed;
}

export async function processSearchIndexBatches(limit = MAX_CONCURRENT_INDEX_WORKERS) {
  if (!supabase) return { claimed: 0, processed: 0, failed: 0 };
  if (!INDEXING_QUEUE_ENABLED) return { claimed: 0, processed: 0, failed: 0, skipped: true, reason: 'Indexing queue disabled' };
  if (await isIndexingPaused()) return { claimed: 0, processed: 0, failed: 0, paused: true };
  if (!isMeilisearchConfigured()) return { claimed: 0, processed: 0, failed: 0, skipped: true, reason: 'Meilisearch is not configured' };

  const claimed = await claimSearchIndexBatches(Math.min(MAX_CONCURRENT_INDEX_WORKERS, Math.max(1, Number(limit) || 1)));
  const results = await Promise.allSettled(claimed.map((batch) => processSearchIndexBatch(batch)));
  const processed = results.filter((result) => result.status === 'fulfilled' && !result.value?.failed).length;
  const failed = results.length - processed;
  return { claimed: claimed.length, processed, failed, results: results.map((result) => result.status === 'fulfilled' ? result.value : { failed: true, error: result.reason?.message || String(result.reason) }) };
}

export async function retryFailedSearchBatches({ runId = null, target = null } = {}) {
  if (!supabase) return { retried: 0 };
  let query = supabase.from('search_index_batches').update({
    status: 'pending',
    next_attempt_at: null,
    locked_at: null,
    locked_by: null,
    error_message: null,
    updated_at: new Date().toISOString(),
  }).in('status', ['retrying', 'dead']);
  if (runId) query = query.eq('run_id', runId);
  if (target) query = query.eq('target', target);
  const { data, error } = await query.select('id');
  if (error) {
    if (isMissingFeature(error)) return { retried: 0 };
    throw error;
  }
  return { retried: (data || []).length };
}

export async function reindexSearchTarget(target = 'all', options = {}) {
  return enqueueSearchReindex(target, options);
}

export async function reindexAllContent(options = {}) {
  return enqueueSearchReindex('all', options);
}

export async function clearSearchIndexes(indexes = Object.values(MEILI_INDEXES)) {
  const ms = getMeilisearchClient();
  if (!ms) throw new Error('Meilisearch is not configured');
  const cleared = [];
  for (const indexName of indexes) {
    if (!Object.values(MEILI_INDEXES).includes(indexName)) continue;
    await ensureIndex(indexName);
    await ms.index(indexName).deleteAllDocuments();
    cleared.push(indexName);
  }
  searchCache.clear();
  return { cleared };
}

export async function getSearchAdminStats() {
  const ms = getMeilisearchClient();
  const health = await getMeilisearchHealth();
  const indexes = [];
  if (ms) {
    await ensureAllIndexes().catch(() => {});
    for (const [key, indexName] of Object.entries(MEILI_INDEXES)) {
      try {
        const stats = await ms.index(indexName).getStats();
        indexes.push({ key, indexName, numberOfDocuments: stats.numberOfDocuments, isIndexing: stats.isIndexing });
      } catch (err) {
        indexes.push({ key, indexName, error: err?.message || String(err) });
      }
    }
  }

  let queue = { pending: 0, failed: 0, dead: 0, recentFailures: [], batches: { pending: 0, running: 0, retrying: 0, completed: 0, dead: 0, recent: [] }, runs: [] };
  let analytics = { recentQueries: [], trending: [] };
  if (supabase) {
    const [pending, failedRows, deadRows, batchRows, runs, recentQueries, trending] = await Promise.all([
      runOptionalSupabaseQuery(
        supabase.from('search_index_queue').select('*', { count: 'exact', head: true }).is('processed_at', null).is('dead_letter_at', null),
        'count pending search queue',
        0,
        (r) => r.count || 0,
      ),
      runOptionalSupabaseQuery(
        supabase.from('search_index_queue').select('*').is('processed_at', null).not('error_message', 'is', null).is('dead_letter_at', null).order('created_at', { ascending: false }).limit(20),
        'load failed search queue rows',
        [],
        (r) => r.data || [],
      ),
      runOptionalSupabaseQuery(
        supabase.from('search_index_dead_letters').select('*', { count: 'exact', head: true }).is('resolved_at', null),
        'count dead search rows',
        0,
        (r) => r.count || 0,
      ),
      runOptionalSupabaseQuery(
        supabase.from('search_index_batches').select('*').order('created_at', { ascending: false }).limit(100),
        'load recent search batches',
        [],
        (r) => r.data || [],
      ),
      runOptionalSupabaseQuery(
        supabase.from('search_sync_runs').select('*').order('started_at', { ascending: false }).limit(10),
        'load recent search runs',
        [],
        (r) => r.data || [],
      ),
      runOptionalSupabaseQuery(
        supabase.from('video_search_queries').select('*').order('created_at', { ascending: false }).limit(20),
        'load recent search queries',
        [],
        (r) => r.data || [],
      ),
      getTrendingSearchQueries(12).catch(() => []),
    ]);
    const statuses = ['pending', 'running', 'retrying', 'completed', 'dead', 'failed'];
    const statusTotals = await Promise.all(statuses.map((status) => runOptionalSupabaseQuery(
      supabase.from('search_index_batches').select('*', { count: 'exact', head: true }).eq('status', status),
      `count ${status} search batches`,
      [status, 0],
      (r) => [status, r.count || 0],
    )));
    const batchCounts = { pending: 0, running: 0, retrying: 0, completed: 0, dead: 0, failed: 0, recent: batchRows.slice(0, 20) };
    for (const [status, count] of statusTotals) batchCounts[status] = count;
    const completedRecent = batchRows.filter((batch) => batch.completed_at && Date.now() - new Date(batch.completed_at).getTime() < 5 * 60_000);
    const recentDurationMs = completedRecent.reduce((sum, batch) => {
      if (!batch.started_at || !batch.completed_at) return sum;
      return sum + Math.max(1, new Date(batch.completed_at).getTime() - new Date(batch.started_at).getTime());
    }, 0);
    queue = {
      pending,
      failed: failedRows.length + batchCounts.retrying + batchCounts.failed,
      dead: deadRows,
      recentFailures: failedRows,
      batches: batchCounts,
      runs,
      throughput: {
        recentCompletedBatches: completedRecent.length,
        recentIndexed: completedRecent.reduce((sum, batch) => sum + Number(batch.indexed_count || 0), 0),
        docsPerSecond: recentDurationMs ? Math.round((completedRecent.reduce((sum, batch) => sum + Number(batch.indexed_count || 0), 0) / (recentDurationMs / 1000)) * 10) / 10 : 0,
      },
    };
    analytics = { recentQueries, trending };
  }
  const paused = await isIndexingPaused().catch(() => indexingPausedFallback);

  return {
    configured: isMeilisearchConfigured(),
    publicConfig: getMeilisearchPublicConfig(),
    health,
    indexes,
    queue,
    workers: {
      enabled: INDEXING_QUEUE_ENABLED,
      paused,
      schedulerRunning: Boolean(syncScheduler),
      queueWorkerBusy: syncSchedulerRunning,
      batchWorkerBusy: batchWorkerRunning,
      maxConcurrentWorkers: MAX_CONCURRENT_INDEX_WORKERS,
      importBatchSize: IMPORT_BATCH_SIZE,
      reindexBatchSize: REINDEX_BATCH_SIZE,
      documentBatchSize: MEILI_DOCUMENT_BATCH_SIZE,
      maxRetries: INDEXING_MAX_RETRIES,
      memory: memoryStats(),
    },
    analytics,
    cache: { size: searchCache.size, ttlMs: SEARCH_CACHE_TTL_MS },
  };
}

export async function getRelatedVideos(videoId, limit = 6) {
  if (!supabase) return [];
  const { data: current } = await supabase.from('tiktok_videos').select('*').eq('video_id', videoId).maybeSingle();
  if (!current) return [];

  const ms = getMeilisearchClient();
  if (ms && current.title) {
    try {
      const result = await ms.index(VIDEOS_INDEX).search(current.title, {
        limit: limit + 1,
        filter: 'deleted = false',
        sort: ['trendingScore:desc'],
      });
      return (result.hits || [])
        .filter((h) => String(h.id) !== String(videoId))
        .slice(0, limit)
        .map(docToHomeCard)
        .filter(Boolean);
    } catch {
      // Fall back to Postgres.
    }
  }

  let query = supabase
    .from('tiktok_videos')
    .select('*')
    .neq('video_id', videoId)
    .is('deleted_at', null)
    .or('is_live.eq.true,status.eq.published')
    .order('views_count', { ascending: false })
    .limit(limit);
  if (current.main_orientation_category) {
    query = query.eq('main_orientation_category', current.main_orientation_category);
  }
  const { data } = await query;
  return (data || []).map(rowToSearchDoc).map(docToHomeCard).filter(Boolean);
}

export function getSearchPublicConfig() {
  const config = getMeilisearchPublicConfig();
  return {
    host: config.host,
    searchKey: config.searchKey,
    indexes: config.indexes,
    directSearchEnabled: Boolean(config.host && config.searchKey),
  };
}

export function makeSearchJobId() {
  return randomUUID();
}

export function startSearchSyncScheduler() {
  if (syncScheduler) return syncScheduler;
  const intervalMs = Number(process.env.SEARCH_SYNC_INTERVAL_MS || 15_000);
  const batchSize = Number(process.env.SEARCH_SYNC_BATCH_SIZE || 100);
  if (!INDEXING_QUEUE_ENABLED || !Number.isFinite(intervalMs) || intervalMs <= 0) return null;

  const run = async () => {
    if (syncSchedulerRunning || !isMeilisearchConfigured() || await isIndexingPaused()) return;
    syncSchedulerRunning = true;
    try {
      const [queueResult, batchResult] = await Promise.all([
        processSearchIndexQueue(batchSize),
        batchWorkerRunning
          ? Promise.resolve({ claimed: 0, processed: 0, failed: 0 })
          : (async () => {
              batchWorkerRunning = true;
              try {
                return await processSearchIndexBatches(MAX_CONCURRENT_INDEX_WORKERS);
              } finally {
                batchWorkerRunning = false;
              }
            })(),
      ]);
      if (queueResult.processed || queueResult.failed || batchResult.claimed || batchResult.failed) {
        console.log(`[search-sync] queue=${queueResult.processed}/${queueResult.failed} batches=${batchResult.processed}/${batchResult.failed} claimed=${batchResult.claimed}`);
      }
    } catch (err) {
      console.warn('[search-sync] queue processing failed:', err?.message || err);
    } finally {
      syncSchedulerRunning = false;
    }
  };

  syncScheduler = setInterval(run, intervalMs);
  syncScheduler.unref?.();
  run().catch(() => {});
  return syncScheduler;
}
