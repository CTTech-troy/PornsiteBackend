import {
  supabase,
  isConfigured,
  isSupabaseAvailable,
  markSupabaseUnavailable,
} from '../config/supabase.js';

const CACHE_TTL_MS = Math.max(5000, Number(process.env.TOP_CREATORS_CACHE_TTL_MS || 60000));
const MAX_LIMIT = Math.max(1, Number(process.env.TOP_CREATORS_MAX_LIMIT || 100));
const FALLBACK_CREATOR_SCAN_LIMIT = Math.max(100, Number(process.env.TOP_CREATORS_FALLBACK_CREATOR_SCAN_LIMIT || 2000));
const FALLBACK_CHUNK_SIZE = Math.max(25, Number(process.env.TOP_CREATORS_FALLBACK_CHUNK_SIZE || 150));
const FALLBACK_PAGE_SIZE = Math.max(100, Number(process.env.TOP_CREATORS_FALLBACK_PAGE_SIZE || 1000));

const leaderboardCache = new Map();

const DEFAULT_SETTINGS = {
  id: 1,
  video_count_weight: 100,
  engagement_weight: 10,
  views_weight: 1,
  recent_activity_weight: 5,
};

const EXCLUDED_VIDEO_STATUSES = new Set(['draft', 'deleted', 'suspended', 'rejected', 'archived', 'removed']);
const COUNTABLE_VIDEO_STATUSES = new Set(['published', 'approved', 'active']);
const EXCLUDED_CREATOR_STATUSES = new Set(['banned', 'suspended', 'removed', 'deleted', 'archived']);

function clampInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePageOptions(options = {}) {
  const limit = clampInt(options.limit, 5, 1, MAX_LIMIT);
  const page = clampInt(options.page, 1, 1, 100000);
  const offset = Number.isFinite(Number(options.offset))
    ? Math.max(0, Number(options.offset))
    : (page - 1) * limit;
  return { limit, page, offset };
}

function isMissingLeaderboardFeature(error) {
  const msg = String(error?.message || '').toLowerCase();
  return (
    error?.code === '42P01' ||
    error?.code === '42703' ||
    error?.code === 'PGRST200' ||
    error?.code === 'PGRST202' ||
    error?.code === 'PGRST204' ||
    msg.includes('schema cache') ||
    msg.includes('does not exist') ||
    msg.includes('could not find')
  );
}

function missingColumnName(error) {
  const msg = String(error?.message || '');
  const quoted = msg.match(/'([^']+)'/);
  if (quoted?.[1]) return quoted[1];
  const named = msg.match(/column\s+["']?([a-zA-Z0-9_]+)["']?/i);
  return named?.[1] || null;
}

function cacheKeyFor(options) {
  return `${options.limit}:${options.page}:${options.offset}`;
}

function getCached(key) {
  const hit = leaderboardCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    leaderboardCache.delete(key);
    return null;
  }
  return { ...hit.value, cached: true };
}

export function invalidateTopCreatorsCache() {
  leaderboardCache.clear();
}

function avatarFallback(seed) {
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(String(seed || 'creator').slice(0, 80))}`;
}

function normalizeLeaderboardRow(row = {}, index = 0, offset = 0) {
  const rank = Number(row.rank_position || offset + index + 1);
  const userId = String(row.creator_id || row.user_id || row.id || '').trim();
  const creatorId = String(row.creator_row_id || row.creatorId || userId).trim();
  const name = String(row.display_name || row.name || row.username || 'Creator').trim() || 'Creator';
  const avatar = row.avatar_url || row.avatar || avatarFallback(userId || name);
  const publishedVideoCount = numberValue(row.published_video_count ?? row.publishedVideoCount ?? row.videoCount ?? row.videosCount, 0);
  const totalViews = numberValue(row.total_views ?? row.totalViews, 0);
  const totalLikes = numberValue(row.total_likes ?? row.totalLikes, 0);
  const totalComments = numberValue(row.total_comments ?? row.totalComments, 0);
  const followers = numberValue(row.follower_count ?? row.followers ?? row.subscribers, 0);
  const averageEngagementRate = numberValue(row.average_engagement_rate ?? row.averageEngagementRate, 0);
  const totalWatchTimeSeconds = numberValue(row.total_watch_time_seconds ?? row.totalWatchTimeSeconds, 0);
  const revenueEarned = numberValue(row.revenue_earned ?? row.revenueEarned, 0);
  const lastActivityAt = row.last_activity_at || row.lastActivityAt || null;

  return {
    id: userId || creatorId || `creator-${rank}`,
    slug: userId || creatorId || name,
    userId,
    user_id: userId,
    creatorId,
    creator_id: creatorId,
    rank,
    rankPosition: rank,
    name,
    displayName: name,
    display_name: name,
    username: row.username || userId || name,
    avatar,
    avatar_url: avatar,
    verified: row.verified === true,
    is_verified: row.verified === true,
    creatorType: row.creator_type || row.creatorType || 'pstar',
    creator_type: row.creator_type || row.creatorType || 'pstar',
    videoCount: publishedVideoCount,
    videosCount: publishedVideoCount,
    publishedVideoCount,
    published_video_count: publishedVideoCount,
    totalViews,
    total_views: totalViews,
    totalLikes,
    total_likes: totalLikes,
    totalComments,
    total_comments: totalComments,
    followers,
    subscribers: followers,
    totalWatchTimeSeconds,
    total_watch_time_seconds: totalWatchTimeSeconds,
    revenueEarned,
    revenue_earned: revenueEarned,
    averageEngagementRate,
    average_engagement_rate: averageEngagementRate,
    engagementScore: numberValue(row.engagement_score ?? row.engagementScore, 0),
    lastActivityAt,
    last_activity_at: lastActivityAt,
    pinnedRank: row.pinned_rank ?? row.pinnedRank ?? null,
    manualRank: row.manual_rank ?? row.manualRank ?? null,
    isFeatured: row.is_featured === true || row.pinned_rank != null,
    _source: row._source || 'platform',
  };
}

async function getSettings() {
  if (!isConfigured() || !supabase) return { ...DEFAULT_SETTINGS };
  try {
    const { data, error } = await supabase
      .from('creator_leaderboard_settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      if (isMissingLeaderboardFeature(error)) return { ...DEFAULT_SETTINGS };
      throw error;
    }
    return { ...DEFAULT_SETTINGS, ...(data || {}) };
  } catch (err) {
    if (markSupabaseUnavailable(err, 'creator leaderboard settings')) return { ...DEFAULT_SETTINGS };
    if (isMissingLeaderboardFeature(err)) return { ...DEFAULT_SETTINGS };
    throw err;
  }
}

async function fetchControls(userIds = []) {
  if (!isConfigured() || !supabase || !userIds.length) return new Map();
  try {
    const { data, error } = await supabase
      .from('creator_leaderboard_controls')
      .select('*')
      .in('creator_id', [...new Set(userIds)]);
    if (error) {
      if (isMissingLeaderboardFeature(error)) return new Map();
      throw error;
    }
    return new Map((data || []).map((row) => [String(row.creator_id), row]));
  } catch (err) {
    if (markSupabaseUnavailable(err, 'creator leaderboard controls')) return new Map();
    if (isMissingLeaderboardFeature(err)) return new Map();
    throw err;
  }
}

async function fetchCreatorRows() {
  const requested = 'id, user_id, display_name, bio, creator_type, active, status, created_at, updated_at';
  let { data, error } = await supabase
    .from('creators')
    .select(requested)
    .limit(FALLBACK_CREATOR_SCAN_LIMIT);
  if (error && isMissingLeaderboardFeature(error)) {
    ({ data, error } = await supabase
      .from('creators')
      .select('id, user_id, display_name, bio, creator_type, created_at')
      .limit(FALLBACK_CREATOR_SCAN_LIMIT));
  }
  if (error) throw error;
  return (data || []).filter((creator) => {
    const status = String(creator.status || 'active').toLowerCase();
    return creator.user_id && creator.active !== false && !EXCLUDED_CREATOR_STATUSES.has(status);
  });
}

async function fetchUsersByIds(userIds = []) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = [];
  const columns = [
    'id',
    'username',
    'display_name',
    'full_name',
    'avatar',
    'avatar_url',
    'followers',
    'following',
    'verified',
    'creator_status',
    'is_verified',
    'email_verified',
    'banned',
    'suspended',
  ];

  for (let i = 0; i < ids.length; i += FALLBACK_CHUNK_SIZE) {
    const slice = ids.slice(i, i + FALLBACK_CHUNK_SIZE);
    let activeColumns = [...columns];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { data, error } = await supabase
        .from('users')
        .select(activeColumns.join(', '))
        .in('id', slice);
      if (!error) {
        rows.push(...(data || []));
        break;
      }
      const missing = missingColumnName(error);
      if (!missing || !activeColumns.includes(missing)) {
        if (isMissingLeaderboardFeature(error)) break;
        throw error;
      }
      activeColumns = activeColumns.filter((column) => column !== missing);
    }
  }

  return new Map(rows.map((row) => [String(row.id), row]));
}

function applyPublicVideoQueryFilters(query, columns = []) {
  const available = new Set(columns);
  let next = query;
  if (available.has('deleted_at')) next = next.is('deleted_at', null);
  if (available.has('visibility')) next = next.eq('visibility', 'public');
  if (available.has('status')) {
    next = next.or('is_live.eq.true,status.in.(published,approved,active)');
  } else if (available.has('is_live')) {
    next = next.eq('is_live', true);
  }
  return next;
}

async function fetchPublicVideoRowsForUsers(userIds = []) {
  const rows = [];
  const ids = [...new Set(userIds.filter(Boolean))];
  const baseColumns = ['video_id', 'user_id', 'status', 'visibility', 'is_live', 'deleted_at', 'views_count', 'likes_count', 'comments_count', 'duration_seconds', 'created_at'];

  for (let i = 0; i < ids.length; i += FALLBACK_CHUNK_SIZE) {
    const slice = ids.slice(i, i + FALLBACK_CHUNK_SIZE);
    for (let from = 0; ; from += FALLBACK_PAGE_SIZE) {
      let activeColumns = [...baseColumns];
      let data = [];
      let loaded = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        let query = supabase
          .from('tiktok_videos')
          .select(activeColumns.join(', '))
          .in('user_id', slice)
          .range(from, from + FALLBACK_PAGE_SIZE - 1);
        query = applyPublicVideoQueryFilters(query, activeColumns);
        const result = await query;
        if (!result.error) {
          data = result.data || [];
          loaded = true;
          break;
        }
        const missing = missingColumnName(result.error);
        if (!missing || !activeColumns.includes(missing)) {
          if (isMissingLeaderboardFeature(result.error)) {
            data = [];
            loaded = true;
            break;
          }
          throw result.error;
        }
        activeColumns = activeColumns.filter((column) => column !== missing);
      }
      if (!loaded) data = [];
      rows.push(...data);
      if (!data || data.length < FALLBACK_PAGE_SIZE) break;
    }
  }

  return rows;
}

async function fetchRevenueByCreator(userIds = []) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const revenue = new Map();
  if (!ids.length) return revenue;
  try {
    for (let i = 0; i < ids.length; i += FALLBACK_CHUNK_SIZE) {
      const slice = ids.slice(i, i + FALLBACK_CHUNK_SIZE);
      const { data, error } = await supabase
        .from('creator_earnings')
        .select('creator_id, amount_usd')
        .in('creator_id', slice);
      if (error) {
        if (isMissingLeaderboardFeature(error)) return revenue;
        throw error;
      }
      for (const row of data || []) {
        const id = String(row.creator_id || '');
        revenue.set(id, (revenue.get(id) || 0) + numberValue(row.amount_usd, 0));
      }
    }
  } catch (err) {
    if (!isMissingLeaderboardFeature(err)) {
      console.warn('[creatorLeaderboard] revenue aggregation skipped:', err?.message || err);
    }
  }
  return revenue;
}

function isCountableVideo(row = {}) {
  const status = String(row.status || 'published').toLowerCase();
  const visibility = String(row.visibility || 'public').toLowerCase();
  if (row.deleted_at) return false;
  if (visibility !== 'public') return false;
  if (EXCLUDED_VIDEO_STATUSES.has(status)) return false;
  return row.is_live === true || COUNTABLE_VIDEO_STATUSES.has(status);
}

function emptyStats() {
  return {
    publishedVideoCount: 0,
    totalViews: 0,
    totalLikes: 0,
    totalComments: 0,
    totalWatchTimeSeconds: 0,
    engagementScore: 0,
    averageEngagementRate: 0,
    lastActivityAt: null,
  };
}

function aggregateVideoRows(rows = []) {
  const byCreator = new Map();
  for (const row of rows) {
    if (!isCountableVideo(row)) continue;
    const userId = String(row.user_id || '').trim();
    if (!userId) continue;
    const stats = byCreator.get(userId) || emptyStats();
    const views = numberValue(row.views_count, 0);
    const likes = numberValue(row.likes_count, 0);
    const comments = numberValue(row.comments_count, 0);
    const duration = numberValue(row.duration_seconds, 0);
    stats.publishedVideoCount += 1;
    stats.totalViews += views;
    stats.totalLikes += likes;
    stats.totalComments += comments;
    stats.totalWatchTimeSeconds += Math.max(0, duration) * views;
    stats.engagementScore += (likes * 3) + (comments * 5) + views;
    const activity = row.created_at ? new Date(row.created_at).getTime() : 0;
    const current = stats.lastActivityAt ? new Date(stats.lastActivityAt).getTime() : 0;
    if (activity > current) stats.lastActivityAt = row.created_at;
    byCreator.set(userId, stats);
  }

  for (const stats of byCreator.values()) {
    stats.averageEngagementRate = stats.totalViews > 0
      ? ((stats.totalLikes + stats.totalComments) / stats.totalViews) * 100
      : 0;
  }
  return byCreator;
}

function userIsBlocked(user = {}) {
  return user.banned === true || user.suspended === true;
}

function userIsVerified(user = {}) {
  const verified = String(user.verified || user.creator_status || '').toLowerCase();
  return user.is_verified === true || user.email_verified === true || ['true', 'approved', 'verified'].includes(verified);
}

function scoreWithSettings(stats, settings) {
  const recentMs = stats.lastActivityAt ? new Date(stats.lastActivityAt).getTime() : 0;
  const daysSinceActivity = recentMs ? Math.max(0, (Date.now() - recentMs) / 86400000) : 365;
  const recentScore = Math.max(0, 365 - daysSinceActivity);
  return (
    (stats.publishedVideoCount * numberValue(settings.video_count_weight, 100)) +
    (stats.engagementScore * numberValue(settings.engagement_weight, 10)) +
    (stats.totalViews * numberValue(settings.views_weight, 1)) +
    (recentScore * numberValue(settings.recent_activity_weight, 5))
  );
}

async function getFallbackLeaderboard(options) {
  const [settings, creators] = await Promise.all([getSettings(), fetchCreatorRows()]);
  const userIds = creators.map((creator) => String(creator.user_id || '')).filter(Boolean);
  if (!userIds.length) {
    return { creators: [], total: 0, page: options.page, limit: options.limit, cached: false, generatedAt: new Date().toISOString(), source: 'fallback' };
  }

  const [usersById, controlsById, videoRows, revenueById] = await Promise.all([
    fetchUsersByIds(userIds),
    fetchControls(userIds),
    fetchPublicVideoRowsForUsers(userIds),
    fetchRevenueByCreator(userIds),
  ]);
  const statsByUserId = aggregateVideoRows(videoRows);

  const ranked = creators
    .map((creator) => {
      const userId = String(creator.user_id || '');
      const user = usersById.get(userId) || {};
      const control = controlsById.get(userId) || {};
      const stats = statsByUserId.get(userId) || emptyStats();
      if (userIsBlocked(user)) return null;
      if (control.excluded === true || control.suspended === true) return null;
      if (stats.publishedVideoCount <= 0) return null;

      const name = creator.display_name || user.display_name || user.full_name || user.username || 'Creator';
      return {
        creator_id: userId,
        creator_row_id: creator.id || userId,
        display_name: name,
        username: user.username || userId,
        avatar_url: user.avatar_url || user.avatar || avatarFallback(userId || name),
        verified: userIsVerified(user),
        creator_type: creator.creator_type || 'pstar',
        published_video_count: stats.publishedVideoCount,
        total_views: stats.totalViews,
        total_likes: stats.totalLikes,
        total_comments: stats.totalComments,
        follower_count: numberValue(user.followers, 0),
        total_watch_time_seconds: stats.totalWatchTimeSeconds,
        revenue_earned: revenueById.get(userId) || 0,
        average_engagement_rate: stats.averageEngagementRate,
        engagement_score: stats.engagementScore,
        last_activity_at: stats.lastActivityAt,
        pinned_rank: control.pinned_rank ?? null,
        manual_rank: control.manual_rank ?? null,
        is_featured: control.pinned_rank != null,
        weighted_score: scoreWithSettings(stats, settings),
        _source: 'fallback',
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aPriority = a.pinned_rank != null ? 0 : a.manual_rank != null ? 1 : 2;
      const bPriority = b.pinned_rank != null ? 0 : b.manual_rank != null ? 1 : 2;
      if (aPriority !== bPriority) return aPriority - bPriority;
      const aManual = a.pinned_rank ?? a.manual_rank ?? Number.MAX_SAFE_INTEGER;
      const bManual = b.pinned_rank ?? b.manual_rank ?? Number.MAX_SAFE_INTEGER;
      if (aManual !== bManual) return aManual - bManual;
      if (b.published_video_count !== a.published_video_count) return b.published_video_count - a.published_video_count;
      if (b.weighted_score !== a.weighted_score) return b.weighted_score - a.weighted_score;
      if (b.engagement_score !== a.engagement_score) return b.engagement_score - a.engagement_score;
      if (b.total_views !== a.total_views) return b.total_views - a.total_views;
      const bd = new Date(b.last_activity_at || 0).getTime();
      const ad = new Date(a.last_activity_at || 0).getTime();
      if (bd !== ad) return bd - ad;
      return String(a.display_name).localeCompare(String(b.display_name));
    })
    .map((row, index) => ({ ...row, rank_position: index + 1, total_count: 0 }));

  const total = ranked.length;
  const paged = ranked.slice(options.offset, options.offset + options.limit);
  return {
    creators: paged.map((row, index) => normalizeLeaderboardRow({ ...row, total_count: total }, index, options.offset)),
    total,
    page: options.page,
    limit: options.limit,
    cached: false,
    generatedAt: new Date().toISOString(),
    source: 'fallback',
  };
}

async function getRpcLeaderboard(options) {
  const { data, error } = await supabase.rpc('get_creator_leaderboard', {
    p_limit: options.limit,
    p_offset: options.offset,
  });
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  const total = rows.length > 0 ? numberValue(rows[0].total_count, rows.length) : 0;
  return {
    creators: rows.map((row, index) => normalizeLeaderboardRow(row, index, options.offset)),
    total,
    page: options.page,
    limit: options.limit,
    cached: false,
    generatedAt: new Date().toISOString(),
    source: 'rpc',
  };
}

export async function getTopCreatorsLeaderboard(rawOptions = {}) {
  const options = normalizePageOptions(rawOptions);
  const key = cacheKeyFor(options);
  const cached = getCached(key);
  if (cached) return cached;

  if (!isConfigured() || !supabase || !isSupabaseAvailable()) {
    return {
      creators: [],
      total: 0,
      page: options.page,
      limit: options.limit,
      cached: false,
      generatedAt: new Date().toISOString(),
      source: 'unavailable',
    };
  }

  let value;
  try {
    value = await getRpcLeaderboard(options);
  } catch (err) {
    if (markSupabaseUnavailable(err, 'creator leaderboard rpc')) {
      value = { creators: [], total: 0, page: options.page, limit: options.limit, cached: false, generatedAt: new Date().toISOString(), source: 'unavailable' };
    } else if (isMissingLeaderboardFeature(err)) {
      value = await getFallbackLeaderboard(options);
    } else {
      throw err;
    }
  }

  leaderboardCache.set(key, { ts: Date.now(), value });
  return value;
}

export async function getCreatorLeaderboardSettings() {
  return getSettings();
}

export async function updateCreatorLeaderboardSettings(payload = {}, adminId = null) {
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const update = {
    video_count_weight: numberValue(payload.video_count_weight ?? payload.videoCountWeight, DEFAULT_SETTINGS.video_count_weight),
    engagement_weight: numberValue(payload.engagement_weight ?? payload.engagementWeight, DEFAULT_SETTINGS.engagement_weight),
    views_weight: numberValue(payload.views_weight ?? payload.viewsWeight, DEFAULT_SETTINGS.views_weight),
    recent_activity_weight: numberValue(payload.recent_activity_weight ?? payload.recentActivityWeight, DEFAULT_SETTINGS.recent_activity_weight),
    updated_by: adminId || null,
  };
  const { data, error } = await supabase
    .from('creator_leaderboard_settings')
    .upsert({ id: 1, ...update }, { onConflict: 'id' })
    .select('*')
    .maybeSingle();
  if (error) throw error;
  invalidateTopCreatorsCache();
  return data || { id: 1, ...update };
}

export async function listCreatorLeaderboardControls() {
  if (!isConfigured() || !supabase) return [];
  const { data, error } = await supabase
    .from('creator_leaderboard_controls')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) {
    if (isMissingLeaderboardFeature(error)) return [];
    throw error;
  }
  return data || [];
}

export async function upsertCreatorLeaderboardControl(payload = {}, adminId = null) {
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const creatorId = String(payload.creator_id || payload.creatorId || '').trim();
  if (!creatorId) throw new Error('creator_id is required');
  const record = {
    creator_id: creatorId,
    excluded: payload.excluded === true,
    suspended: payload.suspended === true,
    pinned_rank: payload.pinned_rank === '' || payload.pinned_rank == null ? null : clampInt(payload.pinned_rank, null, 1, 100000),
    manual_rank: payload.manual_rank === '' || payload.manual_rank == null ? null : clampInt(payload.manual_rank, null, 1, 100000),
    note: String(payload.note || '').trim().slice(0, 1000) || null,
    updated_by: adminId || null,
  };
  const { data, error } = await supabase
    .from('creator_leaderboard_controls')
    .upsert(record, { onConflict: 'creator_id' })
    .select('*')
    .maybeSingle();
  if (error) throw error;
  invalidateTopCreatorsCache();
  return data || record;
}

export async function deleteCreatorLeaderboardControl(creatorId) {
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const id = String(creatorId || '').trim();
  if (!id) throw new Error('creator_id is required');
  const { error } = await supabase
    .from('creator_leaderboard_controls')
    .delete()
    .eq('creator_id', id);
  if (error) throw error;
  invalidateTopCreatorsCache();
  return { deleted: true };
}
