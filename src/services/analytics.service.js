import crypto from 'crypto';
import { supabase } from '../config/supabase.js';
import { isMissingDbFeature } from './revenueCalculation.service.js';

const configuredRawLimit = Number(process.env.ANALYTICS_RAW_QUERY_LIMIT || 5000);
const configuredRawLimitMax = Number(process.env.ANALYTICS_RAW_QUERY_MAX || 5000);
const RAW_LIMIT_MAX = Number.isFinite(configuredRawLimitMax) ? Math.max(500, configuredRawLimitMax) : 5000;
const RAW_LIMIT = Math.floor(Math.min(
  RAW_LIMIT_MAX,
  Math.max(100, Number.isFinite(configuredRawLimit) ? configuredRawLimit : 5000),
));
const TOP_LIMIT = Math.max(5, Number(process.env.ANALYTICS_TOP_LIMIT || 25));
const ACTIVE_WINDOW_MS = Math.max(60_000, Number(process.env.ANALYTICS_ACTIVE_WINDOW_MS || 5 * 60_000));
const OPTIONAL_AGGREGATE_TIMEOUT_MS = Math.max(1000, Number(process.env.ANALYTICS_OPTIONAL_AGGREGATE_TIMEOUT_MS || 5000));
const NGN_PER_USD = Math.max(1, Number(process.env.NGN_PER_USD || 1600));
const SUCCESS_REVENUE_STATUSES = new Set(['active', 'success', 'successful', 'fulfilled', 'paid', 'completed', 'complete', 'verified']);
const ANALYTICS_ENGAGEMENT_TYPES = new Set(['like', 'comment', 'share', 'favorite', 'subscription', 'creator_follow', 'creator_unfollow']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveInt(value, fallback = 0, max = 86400 * 7) {
  return Math.floor(clamp(toNumber(value, fallback), 0, max));
}

function trim(value, max = 240) {
  if (value == null) return null;
  const out = String(value).trim();
  return out ? out.slice(0, max) : null;
}

function safeDate(value, fallback = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : fallback;
}

function iso(value) {
  return safeDate(value).toISOString();
}

function dateKey(value) {
  return iso(value).slice(0, 10);
}

function startOfDay(value = new Date()) {
  const d = safeDate(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(value, days) {
  const d = safeDate(value);
  d.setDate(d.getDate() + days);
  return d;
}

function hashValue(value, namespace = 'analytics') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const salt = process.env.ANALYTICS_HASH_SALT
    || process.env.ENGAGEMENT_HASH_SALT
    || process.env.JWT_SECRET
    || 'xstream-analytics';
  return crypto.createHmac('sha256', salt).update(`${namespace}:${raw}`).digest('hex').slice(0, 48);
}

function getClientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.headers?.['x-real-ip'] || req?.ip || req?.socket?.remoteAddress || '';
}

function parseUserAgent(userAgent = '') {
  const ua = String(userAgent || '');
  const lower = ua.toLowerCase();
  const isTablet = /ipad|tablet|kindle|silk|playbook/i.test(ua);
  const isMobile = !isTablet && /mobile|iphone|ipod|android.*mobile|windows phone/i.test(ua);

  let browser = 'Unknown';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\//i.test(ua) || /opera/i.test(ua)) browser = 'Opera';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/chrome\//i.test(ua) || /crios\//i.test(ua)) browser = 'Chrome';
  else if (/safari\//i.test(ua)) browser = 'Safari';

  let os = 'Unknown';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/mac os|macintosh/i.test(ua)) os = 'Mac';
  else if (/linux/i.test(ua)) os = 'Linux';

  return {
    deviceType: isTablet ? 'Tablet' : isMobile ? 'Mobile' : lower ? 'Desktop' : 'Unknown',
    browser,
    os,
  };
}

function classifyTrafficSource(referrer = '') {
  const raw = String(referrer || '').trim();
  if (!raw) return 'Direct';
  let host = raw.toLowerCase();
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    host = host.replace(/^www\./, '');
  }
  if (/google\./.test(host)) return 'Google Search';
  if (/facebook\.com|fb\.com|m\.facebook/.test(host)) return 'Facebook';
  if (/instagram\.com/.test(host)) return 'Instagram';
  if (/tiktok\.com/.test(host)) return 'TikTok';
  if (/twitter\.com|x\.com/.test(host)) return 'X (Twitter)';
  if (/whatsapp\.com|wa\.me/.test(host)) return 'WhatsApp';
  if (/xstreamvideos\.site|localhost|127\.0\.0\.1/.test(host)) return 'Direct';
  return 'Referral Links';
}

function geoFromRequest(req, body = {}) {
  return {
    country: trim(
      body.country
      || req?.headers?.['cf-ipcountry']
      || req?.headers?.['x-vercel-ip-country']
      || req?.headers?.['x-country']
      || null,
      80,
    ),
    region: trim(body.region || req?.headers?.['x-vercel-ip-country-region'] || req?.headers?.['x-region'] || null, 120),
    city: trim(body.city || req?.headers?.['x-vercel-ip-city'] || req?.headers?.['x-city'] || null, 120),
  };
}

function resolveRange(query = {}) {
  const range = String(query.range || '30d').toLowerCase();
  const now = new Date();
  const to = query.to ? safeDate(query.to, now) : now;
  let from;
  if (query.from) {
    from = safeDate(query.from, addDays(to, -30));
  } else if (range === 'today') {
    from = startOfDay(to);
  } else if (range === '7d' || range === 'week') {
    from = addDays(to, -6);
  } else if (range === '90d' || range === 'quarter') {
    from = addDays(to, -89);
  } else if (range === '12m' || range === 'year') {
    from = addDays(to, -364);
  } else {
    from = addDays(to, -29);
  }
  from.setHours(0, 0, 0, 0);
  return { from, to, range };
}

function normalizeGranularity(granularity, range) {
  const g = String(granularity || '').toLowerCase();
  if (['daily', 'weekly', 'monthly', 'yearly'].includes(g)) return g;
  if (range === '12m' || range === 'year') return 'monthly';
  return 'daily';
}

function bucketKey(value, granularity = 'daily') {
  const d = safeDate(value);
  if (granularity === 'yearly') return `${d.getFullYear()}`;
  if (granularity === 'monthly') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (granularity === 'weekly') {
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return dateKey(d);
}

function makeBuckets(from, to, granularity) {
  const buckets = [];
  const cursor = startOfDay(from);
  const end = startOfDay(to);
  const seen = new Set();
  while (cursor <= end) {
    const key = bucketKey(cursor, granularity);
    if (!seen.has(key)) {
      seen.add(key);
      buckets.push({
        date: key,
        label: key,
        visitors: 0,
        activeUsers: 0,
        views: 0,
        watchTime: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        registrations: 0,
        sessions: 0,
        revenue: 0,
        grossRevenue: 0,
        externalRevenue: 0,
        premiumRevenue: 0,
        adRevenue: 0,
        creatorRevenue: 0,
        revenueTransactions: 0,
      });
    }
    if (granularity === 'yearly') cursor.setFullYear(cursor.getFullYear() + 1);
    else if (granularity === 'monthly') cursor.setMonth(cursor.getMonth() + 1);
    else if (granularity === 'weekly') cursor.setDate(cursor.getDate() + 7);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return buckets;
}

function addToBucket(map, value, dateValue, fields) {
  const key = bucketKey(dateValue, value.granularity);
  const row = map.get(key);
  if (!row) return;
  for (const [field, amount] of Object.entries(fields)) {
    row[field] = toNumber(row[field]) + toNumber(amount);
  }
}

function growthPct(current, previous) {
  const c = toNumber(current);
  const p = toNumber(previous);
  if (p === 0) return c > 0 ? 100 : 0;
  return Math.round(((c - p) / p) * 1000) / 10;
}

async function selectRows(table, columns, { from, to, column = 'created_at', order = 'created_at', limit = RAW_LIMIT, dateOnly = false } = {}) {
  if (!supabase) return [];
  try {
    let query = supabase.from(table).select(columns);
    if (from) query = query.gte(column, dateOnly ? dateKey(from) : iso(from));
    if (to) query = query.lte(column, dateOnly ? dateKey(to) : iso(to));
    query = query.order(order, { ascending: false }).limit(limit);
    const { data, error } = await query;
    if (error) {
      if (isMissingDbFeature(error)) return [];
      console.warn(`[analytics] ${table} query failed:`, error.message || error);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn(`[analytics] ${table} query failed:`, error?.message || error);
    return [];
  }
}

async function countRows(table, configure = (query) => query) {
  if (!supabase) return 0;
  try {
    const query = configure(supabase.from(table).select('id', { count: 'planned', head: true }));
    const { count, error } = await query;
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

async function maybeRpc(name, args = {}) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) {
      if (!isMissingDbFeature(error)) console.warn(`[analytics] rpc ${name} failed:`, error.message || error);
      return null;
    }
    return data;
  } catch (error) {
    console.warn(`[analytics] rpc ${name} failed:`, error?.message || error);
    return null;
  }
}

function withTimeout(promise, timeoutMs, fallback = null) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function getTimedUserDirectoryStats(today) {
  if (!supabase) return null;
  try {
    const { getUserDirectoryAggregateStats } = await import('./userDirectoryService.js');
    return await withTimeout(getUserDirectoryAggregateStats(today).catch(() => null), OPTIONAL_AGGREGATE_TIMEOUT_MS, null);
  } catch {
    return null;
  }
}

async function bumpDaily(date, increments) {
  await maybeRpc('increment_analytics_daily_summary', {
    p_date: date || dateKey(new Date()),
    p_visitors: increments.visitors || 0,
    p_active_users: increments.activeUsers || 0,
    p_views: increments.views || 0,
    p_watch_time: increments.watchTime || 0,
    p_likes: increments.likes || 0,
    p_comments: increments.comments || 0,
    p_shares: increments.shares || 0,
    p_registrations: increments.registrations || 0,
    p_sessions: increments.sessions || 0,
  });
}

async function upsertSession({ sessionId, userId, visitorId = null, incrementPages = 0, incrementVideos = 0, metadata = {}, end = false }) {
  if (!supabase || !sessionId) return null;
  const now = new Date();
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('analytics_sessions')
      .select('session_id,user_id,visitor_id,start_time,pages_visited,videos_watched,duration_seconds,metadata')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (fetchError && isMissingDbFeature(fetchError)) return null;
    if (fetchError) throw fetchError;

    const start = existing?.start_time ? safeDate(existing.start_time, now) : now;
    const duration = Math.max(existing?.duration_seconds || 0, Math.floor((now - start) / 1000));
    const row = {
      session_id: sessionId,
      user_id: userId || existing?.user_id || null,
      visitor_id: visitorId || existing?.visitor_id || null,
      start_time: iso(start),
      last_activity: now.toISOString(),
      end_time: end ? now.toISOString() : null,
      duration_seconds: duration,
      pages_visited: Math.max(existing?.session_id ? 0 : 1, (existing?.pages_visited || 0) + incrementPages),
      videos_watched: Math.max(0, (existing?.videos_watched || 0) + incrementVideos),
      is_active: !end,
      updated_at: now.toISOString(),
      metadata: { ...(existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}), ...metadata },
    };
    const { data, error } = await supabase
      .from('analytics_sessions')
      .upsert(row, { onConflict: 'session_id' })
      .select('*')
      .maybeSingle();
    if (error && !isMissingDbFeature(error)) throw error;
    if (!existing?.session_id) await bumpDaily(dateKey(now), { sessions: 1 });
    return data || row;
  } catch (error) {
    console.warn('[analytics] session upsert failed:', error?.message || error);
    return null;
  }
}

export async function recordAnalyticsVisit(req, body = {}) {
  if (!supabase) return { recorded: false };
  const sessionId = trim(body.sessionId || body.session_id, 160);
  if (!sessionId) return { recorded: false, reason: 'session_required' };

  const userAgent = trim(body.userAgent || req?.get?.('user-agent'), 500);
  const parsedUa = parseUserAgent(userAgent);
  const referrer = trim(body.referrer || req?.get?.('referer'), 500);
  const landingPage = trim(body.landingPage || body.landing_page || body.path || '/', 500);
  const today = dateKey(new Date());
  const userId = trim(req?.uid || body.userId || body.user_id, 160);
  const geo = geoFromRequest(req, body);
  const trafficSource = trim(body.trafficSource || body.traffic_source || classifyTrafficSource(referrer), 120);

  try {
    const row = {
      session_id: sessionId,
      user_id: userId,
      ip_hash: hashValue(getClientIp(req), 'visitor-ip'),
      country: geo.country,
      region: geo.region,
      city: geo.city,
      device_type: trim(body.deviceType || body.device_type || parsedUa.deviceType, 80),
      browser: trim(body.browser || parsedUa.browser, 80),
      os: trim(body.os || parsedUa.os, 80),
      referrer,
      traffic_source: trafficSource,
      landing_page: landingPage,
      visit_date: today,
      updated_at: new Date().toISOString(),
      metadata: {
        viewport: body.viewport || null,
        timezone: trim(body.timezone, 80),
      },
    };

    const { data, error } = await supabase
      .from('analytics_visitors')
      .upsert(row, { onConflict: 'session_id,visit_date' })
      .select('id,created_at,updated_at')
      .maybeSingle();
    if (error) {
      if (isMissingDbFeature(error)) return { recorded: false, missing: true };
      throw error;
    }

    await upsertSession({ sessionId, userId, visitorId: data?.id || null, incrementPages: 1, metadata: row.metadata });
    const createdAt = data?.created_at ? new Date(data.created_at).getTime() : 0;
    const updatedAt = data?.updated_at ? new Date(data.updated_at).getTime() : 0;
    const isNewRow = createdAt && updatedAt && Math.abs(updatedAt - createdAt) < 2000;
    if (isNewRow) await bumpDaily(today, { visitors: 1 });
    return { recorded: true, visitorId: data?.id || null };
  } catch (error) {
    console.warn('[analytics] visit record failed:', error?.message || error);
    return { recorded: false };
  }
}

export async function recordAnalyticsPageView(req, body = {}) {
  const sessionId = trim(body.sessionId || body.session_id, 160);
  if (!sessionId) return { recorded: false, reason: 'session_required' };
  const userId = trim(req?.uid || body.userId || body.user_id, 160);
  await upsertSession({
    sessionId,
    userId,
    incrementPages: 1,
    metadata: {
      path: trim(body.path || body.page || '/', 500),
      title: trim(body.title, 240),
      referrer: trim(body.referrer, 500),
    },
  });
  return { recorded: true };
}

export async function recordAnalyticsHeartbeat(req, body = {}) {
  const sessionId = trim(body.sessionId || body.session_id, 160);
  if (!sessionId) return { recorded: false, reason: 'session_required' };
  await upsertSession({
    sessionId,
    userId: trim(req?.uid || body.userId || body.user_id, 160),
    metadata: { path: trim(body.path || '/', 500), heartbeat: true },
  });
  return { recorded: true };
}

export async function recordAnalyticsSessionEnd(req, body = {}) {
  const sessionId = trim(body.sessionId || body.session_id, 160);
  if (!sessionId) return { recorded: false, reason: 'session_required' };
  await upsertSession({
    sessionId,
    userId: trim(req?.uid || body.userId || body.user_id, 160),
    metadata: { path: trim(body.path || '/', 500), endedByClient: true },
    end: true,
  });
  return { recorded: true };
}

export async function recordAnalyticsVideoWatch(req, body = {}) {
  if (!supabase) return { recorded: false };
  const videoId = trim(body.videoId || body.video_id, 180);
  const sessionId = trim(body.sessionId || body.session_id, 160);
  if (!videoId || !sessionId) return { recorded: false, reason: 'video_and_session_required' };

  const watchDuration = positiveInt(body.watchDuration ?? body.watch_duration ?? body.watchSeconds ?? body.watch_seconds, 0, 86400 * 2);
  if (watchDuration <= 0) return { recorded: false, reason: 'duration_required' };

  const now = new Date();
  const watchId = trim(body.watchId || body.watch_id, 200)
    || hashValue(`${sessionId}:${videoId}:${dateKey(now)}`, 'watch-id');
  const durationSeconds = positiveInt(body.durationSeconds ?? body.duration_seconds, 0, 86400 * 2);
  const progressRatio = clamp(toNumber(body.progressRatio ?? body.progress_ratio, durationSeconds > 0 ? watchDuration / durationSeconds : 0), 0, 1);
  const completed = body.completed === true || progressRatio >= 0.95;
  const userId = trim(req?.uid || body.userId || body.user_id, 160);

  try {
    const previous = await supabase
      .from('analytics_video_views')
      .select('watch_duration,created_at')
      .eq('watch_id', watchId)
      .maybeSingle();
    if (previous.error && isMissingDbFeature(previous.error)) return { recorded: false, missing: true };
    const previousDuration = toNumber(previous.data?.watch_duration, 0);
    const delta = Math.max(0, watchDuration - previousDuration);

    const watchStart = body.watchStart || body.watch_start || previous.data?.created_at || new Date(now.getTime() - watchDuration * 1000).toISOString();
    const row = {
      watch_id: watchId,
      video_id: videoId,
      user_id: userId,
      session_id: sessionId,
      watch_start: iso(watchStart),
      watch_end: iso(body.watchEnd || body.watch_end || now),
      watch_duration: Math.max(previousDuration, watchDuration),
      completed,
      progress_ratio: progressRatio,
      updated_at: now.toISOString(),
      metadata: {
        title: trim(body.title, 300),
        creatorId: trim(body.creatorId || body.creator_id, 160),
        source: trim(body.source || 'web-player', 80),
        durationSeconds,
      },
    };

    const { error } = await supabase.from('analytics_video_views').upsert(row, { onConflict: 'watch_id' });
    if (error) {
      if (isMissingDbFeature(error)) return { recorded: false, missing: true };
      throw error;
    }

    await upsertSession({ sessionId, userId, incrementVideos: previous.data ? 0 : 1, metadata: { lastVideoId: videoId } });
    if (delta > 0 || !previous.data) {
      await bumpDaily(dateKey(now), { views: previous.data ? 0 : 1, watchTime: delta });
    }
    return { recorded: true, watchId };
  } catch (error) {
    console.warn('[analytics] video watch record failed:', error?.message || error);
    return { recorded: false };
  }
}

export async function recordAnalyticsEngagement({
  eventType,
  videoId = null,
  creatorId = null,
  userId = null,
  sessionId = null,
  value = 1,
  metadata = {},
} = {}) {
  if (!supabase) return { recorded: false };
  const type = trim(eventType, 80);
  if (!type) return { recorded: false, reason: 'event_type_required' };
  if (!ANALYTICS_ENGAGEMENT_TYPES.has(type)) return { recorded: false, reason: 'invalid_event_type' };
  try {
    const { error } = await supabase.from('analytics_engagement').insert({
      event_type: type,
      video_id: trim(videoId, 180),
      creator_id: trim(creatorId, 160),
      user_id: trim(userId, 160),
      session_id: trim(sessionId, 160),
      value: Math.max(1, positiveInt(value, 1, 1000)),
      metadata,
    });
    if (error) {
      if (isMissingDbFeature(error)) return { recorded: false, missing: true };
      throw error;
    }
    const increments = {};
    if (type === 'like') increments.likes = 1;
    if (type === 'comment') increments.comments = 1;
    if (type === 'share') increments.shares = 1;
    if (Object.keys(increments).length) await bumpDaily(dateKey(new Date()), increments);
    return { recorded: true };
  } catch (error) {
    console.warn('[analytics] engagement record failed:', error?.message || error);
    return { recorded: false };
  }
}

function uniqueCount(rows, keyFn) {
  const keys = new Set();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (key) keys.add(key);
  }
  return keys.size;
}

function maxSessionDurationSince(rows, since) {
  const cutoff = since ? new Date(since).getTime() : 0;
  let max = 0;
  for (const row of rows || []) {
    const startedAt = new Date(row.start_time || 0).getTime();
    if (cutoff && (!Number.isFinite(startedAt) || startedAt < cutoff)) continue;
    max = Math.max(max, positiveInt(row.duration_seconds, 0, 86400 * 7));
  }
  return max;
}

function summarizeNamed(rows, nameFn, valueFn = () => 1, limit = 10) {
  const map = new Map();
  for (const row of rows || []) {
    const name = nameFn(row) || 'Unknown';
    map.set(name, (map.get(name) || 0) + valueFn(row));
  }
  const total = Array.from(map.values()).reduce((sum, n) => sum + n, 0);
  return Array.from(map.entries())
    .map(([name, value]) => ({ name, value, percent: total > 0 ? Math.round((value / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function successfulRevenueStatus(status) {
  return SUCCESS_REVENUE_STATUSES.has(String(status || '').trim().toLowerCase());
}

function amountToUsd(amount, currency = 'USD') {
  const value = toNumber(amount, 0);
  if (value <= 0) return 0;
  return String(currency || 'USD').toUpperCase() === 'NGN'
    ? Math.round((value / NGN_PER_USD) * 100) / 100
    : Math.round(value * 100) / 100;
}

function metadataObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function positiveMoney(...values) {
  for (const value of values) {
    const num = toNumber(value, NaN);
    if (Number.isFinite(num) && num > 0) return Math.round(num * 100) / 100;
  }
  return 0;
}

function normalizeRevenueSource(productType, fallback = 'Payments') {
  const type = String(productType || '').trim().toLowerCase();
  if (['membership', 'subscription', 'plan'].includes(type)) return 'Memberships';
  if (['coin', 'coins', 'token', 'tokens'].includes(type)) return 'Coin purchases';
  if (type.includes('premium')) return 'Premium video unlocks';
  return fallback;
}

function revenueTotals(rows = []) {
  return rows.reduce((acc, row) => {
    acc.gross += toNumber(row.grossRevenue);
    acc.platform += toNumber(row.platformRevenue);
    acc.external += toNumber(row.externalRevenue);
    acc.premium += toNumber(row.premiumRevenue);
    acc.ads += toNumber(row.adRevenue);
    acc.creator += toNumber(row.creatorRevenue);
    acc.transactions += 1;
    return acc;
  }, {
    gross: 0,
    platform: 0,
    external: 0,
    premium: 0,
    ads: 0,
    creator: 0,
    transactions: 0,
  });
}

function revenueRowsSince(rows, since) {
  return rows.filter((row) => new Date(row.createdAt || row.created_at).getTime() >= since.getTime());
}

async function fetchRevenueFacts({ from, to } = {}) {
  if (!supabase) return [];
  const [
    paymentIntents,
    memberships,
    coinTransactions,
    premiumPurchases,
    adEvents,
  ] = await Promise.all([
    selectRows('payment_intents', 'id,product_type,product_id,status,official_amount,currency,provider,created_at,updated_at', { from, to, limit: RAW_LIMIT }),
    selectRows('user_memberships', 'id,plan_id,status,payment_provider,amount_paid_usd,created_at,started_at', { from, to, column: 'created_at', order: 'created_at', limit: RAW_LIMIT }),
    selectRows('coin_wallet_transactions', 'id,type,amount,status,provider,source_type,source_id,metadata,created_at', { from, to, limit: RAW_LIMIT }),
    selectRows('premium_video_purchases', 'id,video_id,video_title,creator_id,purchase_amount_usd,creator_revenue_usd,platform_revenue_usd,payment_provider,access_status,refund_status,purchased_at', { from, to, column: 'purchased_at', order: 'purchased_at', limit: RAW_LIMIT }),
    selectRows('ad_monitoring_events', 'id,provider_id,event_type,revenue_usd,created_at', { from, to, limit: RAW_LIMIT }),
  ]);

  const rows = [];
  for (const row of paymentIntents) {
    if (!successfulRevenueStatus(row.status)) continue;
    const amountUsd = amountToUsd(row.official_amount, row.currency);
    if (amountUsd <= 0) continue;
    rows.push({
      id: row.id,
      source: normalizeRevenueSource(row.product_type),
      sourceType: 'external_payment',
      grossRevenue: amountUsd,
      platformRevenue: amountUsd,
      externalRevenue: amountUsd,
      premiumRevenue: 0,
      adRevenue: 0,
      creatorRevenue: 0,
      createdAt: row.created_at || row.updated_at,
    });
  }

  const hasMembershipPayments = rows.some((row) => row.source === 'Memberships');
  if (!hasMembershipPayments) {
    for (const row of memberships) {
      if (!successfulRevenueStatus(row.status)) continue;
      const amountUsd = positiveMoney(row.amount_paid_usd);
      if (amountUsd <= 0) continue;
      rows.push({
        id: row.id,
        source: 'Memberships',
        sourceType: 'membership',
        grossRevenue: amountUsd,
        platformRevenue: amountUsd,
        externalRevenue: amountUsd,
        premiumRevenue: 0,
        adRevenue: 0,
        creatorRevenue: 0,
        createdAt: row.created_at || row.started_at,
      });
    }
  }

  const hasCoinPayments = rows.some((row) => row.source === 'Coin purchases');
  if (!hasCoinPayments) {
    for (const row of coinTransactions) {
      if (String(row.type || '').toLowerCase() !== 'purchase' || !successfulRevenueStatus(row.status)) continue;
      const metadata = metadataObject(row.metadata);
      const amountUsd = amountToUsd(positiveMoney(metadata.amountPaid, metadata.amount_paid, metadata.priceUsd, metadata.price_usd, metadata.paymentAmount, metadata.payment_amount), metadata.currency || 'USD');
      if (amountUsd <= 0) continue;
      rows.push({
        id: row.id,
        source: 'Coin purchases',
        sourceType: 'coin_purchase',
        grossRevenue: amountUsd,
        platformRevenue: amountUsd,
        externalRevenue: amountUsd,
        premiumRevenue: 0,
        adRevenue: 0,
        creatorRevenue: 0,
        createdAt: row.created_at,
      });
    }
  }

  for (const row of premiumPurchases) {
    if (!successfulRevenueStatus(row.access_status) || String(row.refund_status || 'none').toLowerCase() === 'completed') continue;
    const gross = positiveMoney(row.purchase_amount_usd);
    const platform = positiveMoney(row.platform_revenue_usd, gross - toNumber(row.creator_revenue_usd));
    const creator = positiveMoney(row.creator_revenue_usd);
    if (gross <= 0 && platform <= 0 && creator <= 0) continue;
    rows.push({
      id: row.id,
      source: 'Premium video unlocks',
      sourceType: 'premium_video',
      grossRevenue: gross || platform + creator,
      platformRevenue: platform,
      externalRevenue: 0,
      premiumRevenue: gross || platform + creator,
      adRevenue: 0,
      creatorRevenue: creator,
      createdAt: row.purchased_at,
    });
  }

  for (const row of adEvents) {
    const revenue = positiveMoney(row.revenue_usd);
    if (revenue <= 0) continue;
    rows.push({
      id: row.id,
      source: 'Ad revenue',
      sourceType: 'ads',
      grossRevenue: revenue,
      platformRevenue: revenue,
      externalRevenue: 0,
      premiumRevenue: 0,
      adRevenue: revenue,
      creatorRevenue: 0,
      createdAt: row.created_at,
    });
  }

  return rows.filter((row) => row.createdAt);
}

async function fetchVideoMetadata(videoIds) {
  const ids = Array.from(new Set((videoIds || []).filter(Boolean))).slice(0, 100);
  if (!ids.length || !supabase) return new Map();
  const columns = 'video_id,title,creator_display_name,creator_avatar_url,user_id,thumbnail_url,thumbnail,poster_url,storage_url,views_count,likes_count,comments_count,created_at';
  let data = [];
  try {
    const res = await supabase.from('tiktok_videos').select(columns).in('video_id', ids);
    if (res.error) {
      const fallback = await supabase
        .from('tiktok_videos')
        .select('video_id,title,user_id,storage_url,views_count,likes_count,comments_count,created_at')
        .in('video_id', ids);
      data = fallback.data || [];
    } else {
      data = res.data || [];
    }
  } catch {
    data = [];
  }
  return new Map(data.map((row) => [String(row.video_id), row]));
}

async function fetchTopVideoCounters(orderColumn, limit = TOP_LIMIT) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('tiktok_videos')
      .select('video_id,title,creator_display_name,user_id,thumbnail_url,thumbnail,poster_url,storage_url,views_count,likes_count,comments_count,created_at')
      .order(orderColumn, { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data || []).map((row) => ({
      videoId: String(row.video_id),
      title: row.title || 'Untitled video',
      thumbnail: row.thumbnail_url || row.thumbnail || row.poster_url || row.storage_url || null,
      creatorId: row.user_id || null,
      creatorName: row.creator_display_name || row.user_id || 'Creator',
      views: toNumber(row.views_count),
      likes: toNumber(row.likes_count),
      comments: toNumber(row.comments_count),
      watchTime: 0,
      growthPct: 0,
    }));
  } catch {
    return [];
  }
}

function aggregateVideoPerformance(analyticsViews, fallbackViews, engagementRows, limit = TOP_LIMIT) {
  const rows = analyticsViews.length ? analyticsViews : fallbackViews.map((row) => ({
    video_id: row.video_id,
    user_id: row.user_id,
    session_id: row.session_id || row.viewer_key || row.fingerprint,
    watch_duration: row.watch_duration ?? row.qualified_watch_seconds ?? 0,
    completed: toNumber(row.progress_ratio) >= 0.95,
    created_at: row.created_at,
  }));
  const map = new Map();
  for (const row of rows) {
    const videoId = String(row.video_id || '');
    if (!videoId) continue;
    const current = map.get(videoId) || {
      videoId,
      views: 0,
      uniqueKeys: new Set(),
      watchTime: 0,
      completed: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      firstSeen: row.created_at,
      lastSeen: row.created_at,
    };
    current.views += 1;
    const viewerKey = row.user_id || row.session_id || row.viewer_key || row.fingerprint;
    if (viewerKey) current.uniqueKeys.add(viewerKey);
    current.watchTime += positiveInt(row.watch_duration ?? row.qualified_watch_seconds, 0, 86400 * 2);
    if (row.completed === true || toNumber(row.progress_ratio) >= 0.95) current.completed += 1;
    current.firstSeen = current.firstSeen && new Date(current.firstSeen) < new Date(row.created_at) ? current.firstSeen : row.created_at;
    current.lastSeen = current.lastSeen && new Date(current.lastSeen) > new Date(row.created_at) ? current.lastSeen : row.created_at;
    map.set(videoId, current);
  }
  for (const row of engagementRows || []) {
    const videoId = String(row.video_id || '');
    if (!videoId) continue;
    const current = map.get(videoId) || {
      videoId,
      views: 0,
      uniqueKeys: new Set(),
      watchTime: 0,
      completed: 0,
      likes: 0,
      comments: 0,
      shares: 0,
    };
    if (row.event_type === 'like') current.likes += 1;
    if (row.event_type === 'comment') current.comments += 1;
    if (row.event_type === 'share') current.shares += 1;
    map.set(videoId, current);
  }
  return Array.from(map.values())
    .map((item) => ({
      videoId: item.videoId,
      views: item.views,
      uniqueViewers: item.uniqueKeys.size,
      watchTime: item.watchTime,
      averageWatchTime: item.views ? Math.round(item.watchTime / item.views) : 0,
      completionRate: item.views ? Math.round((item.completed / item.views) * 1000) / 10 : 0,
      likeRate: item.views ? Math.round((item.likes / item.views) * 1000) / 10 : 0,
      commentRate: item.views ? Math.round((item.comments / item.views) * 1000) / 10 : 0,
      shareRate: item.views ? Math.round((item.shares / item.views) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
}

async function enrichVideos(items) {
  const meta = await fetchVideoMetadata(items.map((item) => item.videoId));
  return items.map((item) => {
    const row = meta.get(String(item.videoId)) || {};
    return {
      ...item,
      title: row.title || item.title || 'Untitled video',
      thumbnail: row.thumbnail_url || row.thumbnail || row.poster_url || row.storage_url || item.thumbnail || null,
      creatorId: row.user_id || item.creatorId || null,
      creatorName: row.creator_display_name || item.creatorName || row.user_id || 'Creator',
      likes: item.likes ?? toNumber(row.likes_count),
      comments: item.comments ?? toNumber(row.comments_count),
    };
  });
}

async function fetchTopCreators() {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('tiktok_videos')
      .select('user_id,creator_display_name,views_count,likes_count,comments_count,created_at')
      .order('views_count', { ascending: false })
      .limit(500);
    if (error) return [];
    const map = new Map();
    for (const row of data || []) {
      const id = row.user_id || 'unknown';
      const current = map.get(id) || {
        creatorId: id,
        creatorName: row.creator_display_name || id,
        views: 0,
        likes: 0,
        comments: 0,
        videos: 0,
        watchTime: 0,
        growthPct: 0,
      };
      current.views += toNumber(row.views_count);
      current.likes += toNumber(row.likes_count);
      current.comments += toNumber(row.comments_count);
      current.videos += 1;
      map.set(id, current);
    }
    return Array.from(map.values()).sort((a, b) => b.views - a.views).slice(0, TOP_LIMIT);
  } catch {
    return [];
  }
}

function buildActivityFeed({ analyticsViews, engagementRows, userRows }) {
  const events = [];
  for (const row of analyticsViews.slice(0, 20)) {
    events.push({
      type: 'view',
      title: 'Video view recorded',
      detail: row.video_id,
      timestamp: row.created_at || row.watch_end || row.watch_start,
    });
  }
  for (const row of engagementRows.slice(0, 20)) {
    events.push({
      type: row.event_type,
      title: `${row.event_type} recorded`,
      detail: row.video_id || row.creator_id || row.user_id || '',
      timestamp: row.created_at,
    });
  }
  for (const row of userRows.slice(0, 10)) {
    events.push({
      type: 'registration',
      title: 'New registration',
      detail: row.email || row.id || 'User',
      timestamp: row.created_at,
    });
  }
  return events
    .filter((event) => event.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 30);
}

export async function getAnalyticsOverview(query = {}) {
  const { from, to, range } = resolveRange(query);
  const granularity = normalizeGranularity(query.granularity, range);
  const today = startOfDay(new Date());
  const weekStart = addDays(today, -6);
  const monthStart = addDays(today, -29);
  const lastHour = new Date(Date.now() - 60 * 60 * 1000);

  const [
    visitorRows,
    sessionRows,
    analyticsViews,
    engagementRows,
    summaryRows,
    fallbackViewRows,
    playbackRows,
    userRows,
    totalUserStats,
    revenueRows,
  ] = await Promise.all([
    selectRows('analytics_visitors', 'id,session_id,user_id,country,region,city,device_type,browser,os,referrer,traffic_source,landing_page,visit_date,created_at', { from, to, column: 'visit_date', order: 'visit_date', dateOnly: true }),
    selectRows('analytics_sessions', 'session_id,user_id,start_time,last_activity,end_time,duration_seconds,pages_visited,videos_watched,is_active,created_at', { from, to, column: 'start_time', order: 'start_time' }),
    selectRows('analytics_video_views', 'id,watch_id,video_id,user_id,session_id,watch_start,watch_end,watch_duration,completed,progress_ratio,created_at,metadata', { from, to }),
    selectRows('analytics_engagement', 'id,event_type,video_id,creator_id,user_id,session_id,value,created_at', { from, to }),
    selectRows('analytics_daily_summary', 'date,visitors,active_users,views,watch_time,likes,comments,shares,registrations,sessions,avg_session_seconds', { from, to, column: 'date', order: 'date', dateOnly: true }),
    selectRows('tiktok_video_views', 'id,video_id,user_id,session_id,viewer_key,fingerprint,qualified_watch_seconds,progress_ratio,created_at', { from, to }),
    selectRows('playback_performance_events', 'video_id,user_id,fingerprint,event_type,current_time,duration,created_at', { from, to }),
    selectRows('users', 'id,email,created_at', { from, to }),
    getTimedUserDirectoryStats(today),
    fetchRevenueFacts({ from, to }),
  ]);

  const hasAnalyticsFacts = visitorRows.length || sessionRows.length || analyticsViews.length || engagementRows.length;
  const viewRowsForMetrics = analyticsViews.length ? analyticsViews : fallbackViewRows.map((row) => ({
    ...row,
    watch_duration: row.qualified_watch_seconds || 0,
    completed: toNumber(row.progress_ratio) >= 0.95,
  }));
  const watchTimeFromPlayback = playbackRows
    .filter((row) => ['watch_progress', 'ended'].includes(row.event_type))
    .reduce((sum, row) => sum + positiveInt(row.current_time, 0, 86400 * 2), 0);

  const visitorKeys = visitorRows.length
    ? visitorRows.map((row) => row.user_id || row.session_id)
    : fallbackViewRows.map((row) => row.user_id || row.viewer_key || row.session_id || row.fingerprint);
  const totalVisitorsInRange = new Set(visitorKeys.filter(Boolean)).size || visitorRows.length;
  const visitsToday = visitorRows.filter((row) => row.visit_date >= dateKey(today)).length
    || uniqueCount(fallbackViewRows.filter((row) => new Date(row.created_at) >= today), (row) => row.user_id || row.viewer_key || row.session_id || row.fingerprint);
  const visitorsWeek = visitorRows.filter((row) => row.visit_date >= dateKey(weekStart)).length;
  const visitorsMonth = visitorRows.filter((row) => row.visit_date >= dateKey(monthStart)).length;

  const sessionKeys = new Set();
  const returningKeys = new Set();
  for (const row of visitorRows) {
    const key = row.user_id || row.session_id;
    if (!key) continue;
    if (sessionKeys.has(key)) returningKeys.add(key);
    sessionKeys.add(key);
  }

  const totalViews = viewRowsForMetrics.length;
  const viewsToday = viewRowsForMetrics.filter((row) => new Date(row.created_at) >= today).length;
  const viewsWeek = viewRowsForMetrics.filter((row) => new Date(row.created_at) >= weekStart).length;
  const viewsMonth = viewRowsForMetrics.filter((row) => new Date(row.created_at) >= monthStart).length;
  const totalWatchTime = viewRowsForMetrics.reduce((sum, row) => sum + positiveInt(row.watch_duration ?? row.qualified_watch_seconds, 0, 86400 * 2), 0)
    || watchTimeFromPlayback;
  const watchToday = viewRowsForMetrics
    .filter((row) => new Date(row.created_at) >= today)
    .reduce((sum, row) => sum + positiveInt(row.watch_duration ?? row.qualified_watch_seconds, 0, 86400 * 2), 0);
  const watchWeek = viewRowsForMetrics
    .filter((row) => new Date(row.created_at) >= weekStart)
    .reduce((sum, row) => sum + positiveInt(row.watch_duration ?? row.qualified_watch_seconds, 0, 86400 * 2), 0);
  const watchMonth = viewRowsForMetrics
    .filter((row) => new Date(row.created_at) >= monthStart)
    .reduce((sum, row) => sum + positiveInt(row.watch_duration ?? row.qualified_watch_seconds, 0, 86400 * 2), 0);

  const totalUsers = totalUserStats?.mergedTotal || totalUserStats?.totalUsers || await countRows('users');
  const signupsToday = totalUserStats?.newToday || userRows.filter((row) => new Date(row.created_at) >= today).length;
  const activeUsersToday = uniqueCount(sessionRows.filter((row) => new Date(row.last_activity || row.start_time) >= today), (row) => row.user_id)
    || uniqueCount(viewRowsForMetrics.filter((row) => new Date(row.created_at) >= today), (row) => row.user_id);
  const activeUsersWeek = uniqueCount(sessionRows.filter((row) => new Date(row.last_activity || row.start_time) >= weekStart), (row) => row.user_id)
    || uniqueCount(viewRowsForMetrics.filter((row) => new Date(row.created_at) >= weekStart), (row) => row.user_id);
  const activeUsersMonth = uniqueCount(sessionRows.filter((row) => new Date(row.last_activity || row.start_time) >= monthStart), (row) => row.user_id)
    || uniqueCount(viewRowsForMetrics.filter((row) => new Date(row.created_at) >= monthStart), (row) => row.user_id);

  const sessionDurations = sessionRows.map((row) => positiveInt(row.duration_seconds, 0, 86400 * 7)).filter((n) => n > 0);
  const avgSessionDuration = sessionDurations.length ? Math.round(sessionDurations.reduce((sum, n) => sum + n, 0) / sessionDurations.length) : 0;
  const longestToday = maxSessionDurationSince(sessionRows, today);
  const longestWeek = maxSessionDurationSince(sessionRows, weekStart);
  const longestMonth = maxSessionDurationSince(sessionRows, monthStart);
  const revenueTotal = revenueTotals(revenueRows);
  const revenueToday = revenueTotals(revenueRowsSince(revenueRows, today));
  const revenueWeek = revenueTotals(revenueRowsSince(revenueRows, weekStart));
  const revenueMonth = revenueTotals(revenueRowsSince(revenueRows, monthStart));

  const bucketTemplate = makeBuckets(from, to, granularity);
  const bucketMap = new Map(bucketTemplate.map((row) => [row.date, row]));
  const ctx = { granularity };

  if (summaryRows.length && !hasAnalyticsFacts) {
    for (const row of summaryRows) {
      addToBucket(bucketMap, ctx, row.date, {
        visitors: row.visitors,
        activeUsers: row.active_users,
        views: row.views,
        watchTime: row.watch_time,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
        registrations: row.registrations,
        sessions: row.sessions,
      });
    }
  } else {
    for (const row of visitorRows) addToBucket(bucketMap, ctx, row.visit_date || row.created_at, { visitors: 1 });
    for (const row of sessionRows) addToBucket(bucketMap, ctx, row.start_time || row.created_at, { sessions: 1, activeUsers: row.user_id ? 1 : 0 });
    for (const row of viewRowsForMetrics) addToBucket(bucketMap, ctx, row.created_at, { views: 1, watchTime: row.watch_duration ?? row.qualified_watch_seconds ?? 0 });
    for (const row of engagementRows) {
      addToBucket(bucketMap, ctx, row.created_at, {
        likes: row.event_type === 'like' ? 1 : 0,
        comments: row.event_type === 'comment' ? 1 : 0,
        shares: row.event_type === 'share' ? 1 : 0,
      });
    }
    for (const row of userRows) addToBucket(bucketMap, ctx, row.created_at, { registrations: 1 });
  }
  for (const row of revenueRows) {
    addToBucket(bucketMap, ctx, row.createdAt, {
      revenue: row.platformRevenue,
      grossRevenue: row.grossRevenue,
      externalRevenue: row.externalRevenue,
      premiumRevenue: row.premiumRevenue,
      adRevenue: row.adRevenue,
      creatorRevenue: row.creatorRevenue,
      revenueTransactions: 1,
    });
  }

  const timeline = Array.from(bucketMap.values()).map((row, index, rows) => ({
    ...row,
    visitorGrowth: growthPct(row.visitors, rows[index - 1]?.visitors || 0),
    viewGrowth: growthPct(row.views, rows[index - 1]?.views || 0),
    watchGrowth: growthPct(row.watchTime, rows[index - 1]?.watchTime || 0),
    revenueGrowth: growthPct(row.revenue, rows[index - 1]?.revenue || 0),
  }));

  const videoPerformance = await enrichVideos(aggregateVideoPerformance(analyticsViews, fallbackViewRows, engagementRows, TOP_LIMIT));
  const [mostLiked, mostCommented, mostViewedByCounters, topCreators] = await Promise.all([
    fetchTopVideoCounters('likes_count', 10),
    fetchTopVideoCounters('comments_count', 10),
    fetchTopVideoCounters('views_count', 10),
    fetchTopCreators(),
  ]);
  const highestWatchTime = [...videoPerformance].sort((a, b) => b.watchTime - a.watchTime).slice(0, 10);
  const fastestGrowing = [...videoPerformance].sort((a, b) => b.views - a.views).slice(0, 10);

  const realtime = await getRealtimeAnalytics();

  return {
    range: { from: from.toISOString(), to: to.toISOString(), granularity },
    generatedAt: new Date().toISOString(),
    sources: {
      analyticsFacts: Boolean(hasAnalyticsFacts),
      fallbackTables: hasAnalyticsFacts ? [] : ['tiktok_video_views', 'playback_performance_events', 'tiktok_video_likes', 'tiktok_video_comments'],
      revenueFacts: revenueRows.length > 0,
    },
    kpis: {
      visitors: {
        total: totalVisitorsInRange,
        today: visitsToday,
        week: visitorsWeek || totalVisitorsInRange,
        month: visitorsMonth || totalVisitorsInRange,
        returning: returningKeys.size,
        newVisitors: Math.max(0, totalVisitorsInRange - returningKeys.size),
      },
      users: {
        total: totalUsers,
        activeToday: activeUsersToday,
        activeWeek: activeUsersWeek,
        activeMonth: activeUsersMonth,
        returning: uniqueCount(sessionRows.filter((row) => toNumber(row.pages_visited) > 1), (row) => row.user_id),
        newSignups: signupsToday,
      },
      videos: {
        totalViews,
        viewsToday,
        viewsWeek,
        viewsMonth,
      },
      watchTime: {
        total: totalWatchTime,
        today: watchToday,
        week: watchWeek,
        month: watchMonth,
        averagePerUser: activeUsersMonth ? Math.round(watchMonth / activeUsersMonth) : 0,
        averagePerSession: sessionRows.length ? Math.round(totalWatchTime / sessionRows.length) : 0,
        averagePerVideo: totalViews ? Math.round(totalWatchTime / totalViews) : 0,
      },
      sessions: {
        averageDuration: avgSessionDuration,
        longestToday,
        longestWeek,
        longestMonth,
        totalTimeSpent: sessionDurations.reduce((sum, n) => sum + n, 0),
      },
      engagement: {
        likes: engagementRows.filter((row) => row.event_type === 'like').length || await countRows('tiktok_video_likes', (q) => q.gte('created_at', from.toISOString()).lte('created_at', to.toISOString())),
        comments: engagementRows.filter((row) => row.event_type === 'comment').length || await countRows('tiktok_video_comments', (q) => q.gte('created_at', from.toISOString()).lte('created_at', to.toISOString())),
        shares: engagementRows.filter((row) => row.event_type === 'share').length,
        favorites: engagementRows.filter((row) => row.event_type === 'favorite').length,
        subscriptions: engagementRows.filter((row) => row.event_type === 'subscription').length,
        creatorFollows: engagementRows.filter((row) => row.event_type === 'creator_follow').length,
      },
      revenue: {
        total: Math.round(revenueTotal.platform * 100) / 100,
        gross: Math.round(revenueTotal.gross * 100) / 100,
        externalPayments: Math.round(revenueTotal.external * 100) / 100,
        premiumContent: Math.round(revenueTotal.premium * 100) / 100,
        adRevenue: Math.round(revenueTotal.ads * 100) / 100,
        creatorRevenue: Math.round(revenueTotal.creator * 100) / 100,
        today: Math.round(revenueToday.platform * 100) / 100,
        week: Math.round(revenueWeek.platform * 100) / 100,
        month: Math.round(revenueMonth.platform * 100) / 100,
        transactions: revenueTotal.transactions,
      },
    },
    charts: {
      timeline,
      visitors: timeline.map((row) => ({ date: row.date, visitors: row.visitors, growth: row.visitorGrowth })),
      users: timeline.map((row) => ({ date: row.date, activeUsers: row.activeUsers, registrations: row.registrations })),
      views: timeline.map((row) => ({ date: row.date, views: row.views, growth: row.viewGrowth })),
      watchTime: timeline.map((row) => ({ date: row.date, watchTime: row.watchTime, growth: row.watchGrowth })),
      revenue: timeline.map((row) => ({
        date: row.date,
        revenue: row.revenue,
        grossRevenue: row.grossRevenue,
        externalRevenue: row.externalRevenue,
        premiumRevenue: row.premiumRevenue,
        adRevenue: row.adRevenue,
        creatorRevenue: row.creatorRevenue,
        transactions: row.revenueTransactions,
        growth: row.revenueGrowth,
      })),
      revenueSources: summarizeNamed(revenueRows, (row) => row.source, (row) => row.platformRevenue || row.grossRevenue),
      trafficSources: summarizeNamed(visitorRows, (row) => row.traffic_source || classifyTrafficSource(row.referrer)),
      deviceTypes: summarizeNamed(visitorRows, (row) => row.device_type),
      browsers: summarizeNamed(visitorRows, (row) => row.browser),
      operatingSystems: summarizeNamed(visitorRows, (row) => row.os),
      countries: summarizeNamed(visitorRows, (row) => row.country),
      cities: summarizeNamed(visitorRows, (row) => row.city),
      regions: summarizeNamed(visitorRows, (row) => row.region),
    },
    videoPerformance,
    content: {
      mostViewed: mostViewedByCounters.length ? mostViewedByCounters : videoPerformance.slice(0, 10),
      mostLiked,
      mostCommented,
      mostShared: videoPerformance.filter((row) => row.shareRate > 0).slice(0, 10),
      highestWatchTime,
      fastestGrowing,
      topCreators,
    },
    realtime,
    activityFeed: buildActivityFeed({
      analyticsViews: analyticsViews.filter((row) => new Date(row.created_at) >= lastHour),
      engagementRows: engagementRows.filter((row) => new Date(row.created_at) >= lastHour),
      userRows: userRows.filter((row) => new Date(row.created_at) >= lastHour),
    }),
  };
}

export async function getRealtimeAnalytics() {
  const activeSince = new Date(Date.now() - ACTIVE_WINDOW_MS);
  const lastHour = new Date(Date.now() - 60 * 60 * 1000);
  const today = startOfDay(new Date());
  const [sessions, recentViews, recentPlayback, recentEngagement, recentUsers, recentRevenue] = await Promise.all([
    selectRows('analytics_sessions', 'session_id,user_id,last_activity,videos_watched', { from: activeSince, column: 'last_activity', order: 'last_activity', limit: 5000 }),
    selectRows('analytics_video_views', 'video_id,user_id,session_id,created_at', { from: lastHour, limit: 5000 }),
    selectRows('playback_performance_events', 'video_id,user_id,fingerprint,event_type,created_at', { from: activeSince, limit: 5000 }),
    selectRows('analytics_engagement', 'event_type,video_id,creator_id,user_id,created_at', { from: lastHour, limit: 5000 }),
    selectRows('users', 'id,email,created_at', { from: today, limit: 5000 }),
    fetchRevenueFacts({ from: lastHour }),
  ]);
  const recentRevenueTotals = revenueTotals(recentRevenue);

  const activeAuthed = uniqueCount(sessions.filter((row) => row.user_id), (row) => row.user_id);
  const activeGuests = uniqueCount(sessions.filter((row) => !row.user_id), (row) => row.session_id);
  const activeVideoIds = new Set([
    ...recentViews.map((row) => row.video_id),
    ...recentPlayback.filter((row) => ['play_start', 'playing', 'watch_progress'].includes(row.event_type)).map((row) => row.video_id),
  ].filter(Boolean));

  const likesLastHour = recentEngagement.filter((row) => row.event_type === 'like').length
    || await countRows('tiktok_video_likes', (q) => q.gte('created_at', lastHour.toISOString()));
  const commentsLastHour = recentEngagement.filter((row) => row.event_type === 'comment').length
    || await countRows('tiktok_video_comments', (q) => q.gte('created_at', lastHour.toISOString()));

  return {
    usersOnlineNow: activeAuthed,
    guestsOnlineNow: activeGuests,
    videosBeingWatched: activeVideoIds.size,
    newRegistrationsToday: recentUsers.length,
    newViewsLast60Minutes: recentViews.length || await countRows('tiktok_video_views', (q) => q.gte('created_at', lastHour.toISOString())),
    newLikesLast60Minutes: likesLastHour,
    newCommentsLast60Minutes: commentsLastHour,
    newRevenueLast60Minutes: Math.round(recentRevenueTotals.platform * 100) / 100,
    newPaymentsLast60Minutes: recentRevenueTotals.transactions,
    updatedAt: new Date().toISOString(),
  };
}

export async function refreshAnalyticsDailySummary(query = {}) {
  const { from, to } = resolveRange(query);
  const rows = await maybeRpc('refresh_analytics_daily_summary', {
    p_from: dateKey(from),
    p_to: dateKey(to),
  });
  return { refreshed: rows != null, rows: rows || 0 };
}
