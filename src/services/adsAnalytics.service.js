import PDFDocument from 'pdfkit';
import { appMemoryCache } from './localMemoryCache.service.js';
import {
  EXOCLICK_DISPLAY_SCRIPT_URL,
  EXOCLICK_DISPLAY_ZONE_ID,
  EXOCLICK_VAST_TAG_URL,
  EXOCLICK_VAST_ZONE_ID,
  listProviders,
  listZones as listCodeManagedZones,
} from './adProvider.service.js';

const EXOCLICK_API_BASE = 'https://api.exoclick.com/v2';
const ADSTERRA_API_BASE = 'https://api3.adsterratools.com/publisher';
const CACHE_TTL_MS = Math.max(60_000, Number(process.env.ADS_ANALYTICS_CACHE_TTL_MS || 5 * 60 * 1000));
const HTTP_TIMEOUT_MS = Math.max(5_000, Number(process.env.ADS_ANALYTICS_HTTP_TIMEOUT_MS || 20_000));
const MAX_RETRIES = Math.max(0, Number(process.env.ADS_ANALYTICS_MAX_RETRIES || 2));
const TZ = process.env.ADS_ANALYTICS_TIMEZONE || 'Africa/Lagos';

const PLATFORM_EXOCLICK = 'exoclick';
const PLATFORM_ADSTERRA = 'adsterra';
const PROVIDERS = [PLATFORM_EXOCLICK, PLATFORM_ADSTERRA];

export const SUPPORTED_AD_FORMATS = {
  exoclick: ['Banner', 'Native', 'Popunder', 'Video Slider', 'In-Stream', 'Push', 'Interstitial', 'Direct Link'],
  adsterra: ['Banner', 'Native', 'Popunder', 'Social Bar', 'Direct Link', 'Interstitial', 'Video Pre-roll', 'Smartlink'],
};

const CODE_MANAGED_ADSTERRA_ZONES = [
  {
    id: 'adsterra-highperformance-after-header-728x90',
    zoneId: '8af10b683371ed20d23f25c00177c8e8',
    zoneName: 'After Header Leaderboard',
    platform: PLATFORM_ADSTERRA,
    adFormat: 'Banner',
    width: 728,
    height: 90,
    placement: 'leaderboard',
    status: 'active',
    source: 'code',
  },
  {
    id: 'adsterra-highperformance-featured-creators-468x60',
    zoneId: 'bf7e2b576f6b89a566c105181590bb40',
    zoneName: 'Featured Creators Banner',
    platform: PLATFORM_ADSTERRA,
    adFormat: 'Banner',
    width: 468,
    height: 60,
    placement: 'featured_creators',
    status: 'active',
    source: 'code',
  },
  {
    id: 'adsterra-highperformance-feed-300x250',
    zoneId: '66bb1fce574057a337d12dddd9b3e3f5',
    zoneName: 'In-feed Video Card MPU',
    platform: PLATFORM_ADSTERRA,
    adFormat: 'Native',
    width: 300,
    height: 250,
    placement: 'feed_native',
    status: 'active',
    source: 'code',
  },
  {
    id: 'adsterra-effectivecpm-before-footer-970x280',
    zoneId: '52171fe16f90c105411bcb3fb818c798',
    zoneName: 'Before Footer Network Container',
    platform: PLATFORM_ADSTERRA,
    adFormat: 'Native',
    width: 970,
    height: 280,
    placement: 'before_footer',
    status: 'active',
    source: 'code',
  },
  {
    id: 'adsterra-effectivecpm-smartlink-video-sidebar',
    zoneId: '0412d8c10f156248f3d31b2b41133788',
    zoneName: 'Video Sidebar Smartlink',
    platform: PLATFORM_ADSTERRA,
    adFormat: 'Smartlink',
    width: 300,
    height: 96,
    placement: 'video_sidebar',
    status: 'active',
    source: 'code',
  },
];

let exoBearer = null;

export class AdsProviderError extends Error {
  constructor(message, { platform, status = 0, code = 'API_ERROR', retryAfterMs = 0, details = null } = {}) {
    super(message);
    this.name = 'AdsProviderError';
    this.platform = platform;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

function configured(platform) {
  if (platform === PLATFORM_EXOCLICK) return Boolean(String(process.env.EXOCLICK_API_KEY || '').trim());
  if (platform === PLATFORM_ADSTERRA) return Boolean(String(process.env.ADSTERRA_API_KEY || '').trim());
  return false;
}

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const num = Number(String(value).replace(/[$,%\s]/g, ''));
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((safeNumber(value) + Number.EPSILON) * factor) / factor;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function safeDate(value, fallback = new Date()) {
  const date = value ? new Date(value) : fallback;
  return Number.isFinite(date.getTime()) ? date : fallback;
}

export function resolveAdsDateRange(query = {}) {
  const preset = String(query.range || query.dateRange || 'last30').trim();
  const now = new Date();
  const today = startOfDay(now);
  let from = addDays(today, -29);
  let to = endOfDay(now);

  if (preset === 'today') {
    from = today;
    to = endOfDay(now);
  } else if (preset === 'yesterday') {
    from = startOfDay(addDays(today, -1));
    to = endOfDay(addDays(today, -1));
  } else if (preset === 'last7') {
    from = startOfDay(addDays(today, -6));
  } else if (preset === 'last30') {
    from = startOfDay(addDays(today, -29));
  } else if (preset === 'thisMonth') {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
  } else if (preset === 'lastMonth') {
    from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    to = endOfDay(new Date(today.getFullYear(), today.getMonth(), 0));
  } else if (preset === 'thisYear') {
    from = new Date(today.getFullYear(), 0, 1);
  } else if (preset === 'custom') {
    from = startOfDay(safeDate(query.from || query.startDate, from));
    to = endOfDay(safeDate(query.to || query.endDate, to));
  }

  if (from > to) [from, to] = [to, from];
  return {
    preset,
    from,
    to,
    fromDate: dateKey(from),
    toDate: dateKey(to),
  };
}

function monthRange() {
  return resolveAdsDateRange({ range: 'thisMonth' });
}

function todayRange() {
  return resolveAdsDateRange({ range: 'today' });
}

function yesterdayRange() {
  return resolveAdsDateRange({ range: 'yesterday' });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendQuery(url, params = {}) {
  for (const [key, raw] of Object.entries(params || {})) {
    if (raw == null || raw === '') continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value == null || value === '') continue;
      url.searchParams.append(key, String(value));
    }
  }
}

function parseRetryAfter(headers) {
  const raw = headers?.get?.('retry-after') || headers?.get?.('x-rate-limit-reset') || '';
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  return 0;
}

async function httpJson(url, options = {}, { platform, retries = MAX_RETRIES } = {}) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      const text = await response.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text.slice(0, 500) };
        }
      }

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers);
        const code = response.status === 429
          ? 'RATE_LIMITED'
          : response.status === 401 || response.status === 403
            ? 'AUTH_FAILED'
            : 'API_ERROR';
        const message = body?.message || body?.error || `${platform} API request failed with ${response.status}`;
        const err = new AdsProviderError(message, {
          platform,
          status: response.status,
          code,
          retryAfterMs,
          details: body,
        });
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          await sleep(retryAfterMs || (400 * (attempt + 1)));
          attempt += 1;
          continue;
        }
        throw err;
      }
      if (body != null && typeof body !== 'object') {
        throw new AdsProviderError(`${platform} API returned an invalid response`, {
          platform,
          status: response.status,
          code: 'INVALID_RESPONSE',
        });
      }
      return body || {};
    } catch (err) {
      lastError = err;
      const abort = err?.name === 'AbortError';
      const providerError = err instanceof AdsProviderError;
      if (providerError && !['RATE_LIMITED', 'API_ERROR'].includes(err.code)) throw err;
      if (attempt >= retries) break;
      await sleep(abort ? 500 * (attempt + 1) : 350 * (attempt + 1));
      attempt += 1;
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof AdsProviderError) throw lastError;
  throw new AdsProviderError(lastError?.message || `${platform} API unavailable`, {
    platform,
    code: lastError?.name === 'AbortError' ? 'TIMEOUT' : 'API_UNAVAILABLE',
  });
}

async function getExoBearerToken() {
  const apiToken = String(process.env.EXOCLICK_API_KEY || '').trim();
  if (!apiToken) throw new AdsProviderError('EXOCLICK_API_KEY is not configured.', { platform: PLATFORM_EXOCLICK, code: 'MISSING_KEY' });
  if (exoBearer && exoBearer.expiresAt > Date.now() + 60_000) return exoBearer.token;

  const body = await httpJson(`${EXOCLICK_API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ api_token: apiToken }),
  }, { platform: PLATFORM_EXOCLICK, retries: 1 });

  const token = body?.token || body?.access_token || body?.bearer_token;
  if (!token) {
    throw new AdsProviderError('ExoClick login succeeded but did not return a bearer token.', {
      platform: PLATFORM_EXOCLICK,
      code: 'INVALID_RESPONSE',
      details: { keys: Object.keys(body || {}) },
    });
  }

  const expiresIn = Math.max(300, safeNumber(body.expires_in, 900));
  exoBearer = {
    token,
    expiresAt: Date.now() + (expiresIn * 1000),
  };
  return token;
}

async function exoGet(path, params = {}) {
  const token = await getExoBearerToken();
  const url = new URL(`${EXOCLICK_API_BASE}${path}`);
  appendQuery(url, params);
  return httpJson(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  }, { platform: PLATFORM_EXOCLICK });
}

async function adsterraGet(path, params = {}) {
  const apiKey = String(process.env.ADSTERRA_API_KEY || '').trim();
  if (!apiKey) throw new AdsProviderError('ADSTERRA_API_KEY is not configured.', { platform: PLATFORM_ADSTERRA, code: 'MISSING_KEY' });
  const url = new URL(`${ADSTERRA_API_BASE}${path}`);
  appendQuery(url, params);
  return httpJson(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-API-Key': apiKey,
    },
  }, { platform: PLATFORM_ADSTERRA });
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['result', 'data', 'items', 'rows', 'records', 'stats', 'statistics', 'domains', 'placements', 'smartlinks', 'zones']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function getGroupValue(row, names) {
  const group = row?.group_by || row?.groupBy || row?.group || {};
  for (const name of names) {
    const direct = row?.[name] ?? row?.[`${name}_id`] ?? row?.[`${name}Id`];
    if (direct != null && direct !== '') return direct;
    const nested = group?.[name] || group?.[`${name}_id`] || group?.[`${name}Id`];
    if (nested == null) continue;
    if (typeof nested === 'object') {
      return nested.date || nested.id || nested.name || nested.title || nested.value || nested.label;
    }
    return nested;
  }
  return null;
}

function getGroupName(row, names) {
  const group = row?.group_by || row?.groupBy || row?.group || {};
  for (const name of names) {
    const direct = row?.[`${name}_name`] ?? row?.[`${name}Name`] ?? row?.name ?? row?.title;
    if (direct != null && direct !== '') return String(direct);
    const nested = group?.[name] || group?.[`${name}_id`] || group?.[`${name}Id`];
    if (nested && typeof nested === 'object') {
      return String(nested.name || nested.title || nested.label || nested.id || nested.date || '');
    }
  }
  const value = getGroupValue(row, names);
  return value == null ? '' : String(value);
}

function normalizeMetrics(row = {}) {
  const impressions = safeNumber(row.impressions ?? row.impression ?? row.views ?? row.view);
  const clicks = safeNumber(row.clicks ?? row.click);
  const revenue = safeNumber(row.revenue ?? row.earned ?? row.money ?? row.profit ?? row.amount);
  const estimatedRevenue = safeNumber(row.estimated_revenue ?? row.estimatedRevenue ?? row.revenue_estimated, revenue);
  const adRequests = safeNumber(
    row.adRequests ?? row.ad_requests ?? row.requests ?? row.request ?? row.queries ?? row.rtb?.queries,
    impressions,
  );
  const cpm = safeNumber(row.cpm ?? row.ecpm ?? row.eCPM, impressions ? (revenue / impressions) * 1000 : 0);
  const cpc = safeNumber(row.cpc, clicks ? revenue / clicks : 0);
  const ctr = safeNumber(row.ctr, impressions ? (clicks / impressions) * 100 : 0);
  const fillRate = safeNumber(row.fill_rate ?? row.fillRate ?? row.fillrate, adRequests ? (impressions / adRequests) * 100 : (impressions ? 100 : 0));
  return {
    revenue: round(revenue, 4),
    estimatedRevenue: round(estimatedRevenue, 4),
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    adRequests: Math.round(adRequests),
    cpm: round(cpm, 4),
    cpc: round(cpc, 4),
    ctr: round(ctr, 4),
    fillRate: round(Math.min(100, Math.max(0, fillRate)), 4),
  };
}

function emptySummary() {
  return {
    todayRevenue: 0,
    yesterdayRevenue: 0,
    monthlyRevenue: 0,
    totalRevenue: 0,
    estimatedRevenue: 0,
    impressions: 0,
    clicks: 0,
    adRequests: 0,
    fillRate: 0,
    cpm: 0,
    cpc: 0,
    ctr: 0,
    activeZones: 0,
    activeCampaigns: 0,
  };
}

function summarizeRows(rows = []) {
  const summary = emptySummary();
  for (const row of rows) {
    const metrics = row.metrics ? row : { metrics: normalizeMetrics(row) };
    summary.totalRevenue += safeNumber(metrics.metrics?.revenue);
    summary.estimatedRevenue += safeNumber(metrics.metrics?.estimatedRevenue);
    summary.impressions += safeNumber(metrics.metrics?.impressions);
    summary.clicks += safeNumber(metrics.metrics?.clicks);
    summary.adRequests += safeNumber(metrics.metrics?.adRequests);
  }
  summary.cpm = summary.impressions ? (summary.totalRevenue / summary.impressions) * 1000 : 0;
  summary.cpc = summary.clicks ? summary.totalRevenue / summary.clicks : 0;
  summary.ctr = summary.impressions ? (summary.clicks / summary.impressions) * 100 : 0;
  summary.fillRate = summary.adRequests ? (summary.impressions / summary.adRequests) * 100 : (summary.impressions ? 100 : 0);
  return roundSummary(summary);
}

function roundSummary(summary) {
  return {
    ...summary,
    todayRevenue: round(summary.todayRevenue),
    yesterdayRevenue: round(summary.yesterdayRevenue),
    monthlyRevenue: round(summary.monthlyRevenue),
    totalRevenue: round(summary.totalRevenue),
    estimatedRevenue: round(summary.estimatedRevenue),
    impressions: Math.round(summary.impressions),
    clicks: Math.round(summary.clicks),
    adRequests: Math.round(summary.adRequests),
    fillRate: round(summary.fillRate),
    cpm: round(summary.cpm),
    cpc: round(summary.cpc, 4),
    ctr: round(summary.ctr),
    activeZones: Math.round(summary.activeZones),
    activeCampaigns: Math.round(summary.activeCampaigns),
  };
}

function normalizeTimeRow(row, platform, group = 'date') {
  const metrics = normalizeMetrics(row);
  let key = getGroupValue(row, [group, 'date', 'hour', 'day']);
  if (key == null && row.date) key = row.date;
  if (group === 'hour') {
    const hour = safeNumber(key ?? row.hour, 0);
    key = String(hour).padStart(2, '0');
  }
  const label = getGroupName(row, [group, 'date', 'hour', 'day']) || String(key || '');
  return { platform, key: String(key || label || 'unknown'), label: String(label || key || 'Unknown'), metrics, raw: row };
}

function detectFormat(row = {}, fallback = 'Banner') {
  const value = String(
    row.adFormat ||
    row.ad_format ||
    row.format ||
    row.type ||
    row.zone_type ||
    row.publisher_ad_type_name ||
    row.publisher_ad_type ||
    row.media_storage_template ||
    fallback ||
    'Banner',
  ).replace(/[_-]+/g, ' ').trim();
  if (!value) return fallback;
  if (/smart/i.test(value)) return 'Smartlink';
  if (/pre.?roll|vast|in.?stream|video/i.test(value)) return 'In-Stream';
  if (/native/i.test(value)) return 'Native';
  if (/pop/i.test(value)) return 'Popunder';
  if (/social/i.test(value)) return 'Social Bar';
  if (/direct/i.test(value)) return 'Direct Link';
  return value.split(/\s+/).map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase()).join(' ');
}

function normalizeZoneRow(row = {}, platform, metricsByZone = new Map(), fallback = {}) {
  const groupZone = row.group_by?.zone || row.group?.zone || {};
  const zoneId = String(
    row.zoneId ||
    row.zone_id ||
    row.id ||
    row.placement_id ||
    row.placement ||
    groupZone.id ||
    fallback.zoneId ||
    '',
  ).trim();
  const zoneName = String(
    row.zoneName ||
    row.zone_name ||
    row.name ||
    row.title ||
    row.placement_name ||
    row.domain_name ||
    groupZone.name ||
    fallback.zoneName ||
    zoneId ||
    'Unknown zone',
  ).trim();
  const status = String(row.status || row.state || row.active || fallback.status || 'active').toLowerCase();
  const id = String(row.id || fallback.id || `${platform}-${zoneId || zoneName}`).trim();
  const metrics = metricsByZone.get(zoneId) || metricsByZone.get(zoneName) || normalizeMetrics(row);
  const impressions = safeNumber(metrics.impressions);
  const requests = safeNumber(metrics.adRequests);
  return {
    id,
    zoneName,
    zoneId,
    platform,
    adFormat: detectFormat(row, fallback.adFormat || 'Banner'),
    status: status === '1' || status === 'true' ? 'active' : status,
    revenue: round(metrics.revenue),
    impressions: Math.round(impressions),
    clicks: Math.round(metrics.clicks),
    adRequests: Math.round(requests),
    cpm: round(metrics.cpm || (impressions ? (metrics.revenue / impressions) * 1000 : 0)),
    cpc: round(metrics.cpc || (metrics.clicks ? metrics.revenue / metrics.clicks : 0), 4),
    ctr: round(metrics.ctr || (impressions ? (metrics.clicks / impressions) * 100 : 0)),
    fillRate: round(metrics.fillRate || (requests ? (impressions / requests) * 100 : (impressions ? 100 : 0))),
    width: safeNumber(row.width || fallback.width, null),
    height: safeNumber(row.height || fallback.height, null),
    placement: row.placement || fallback.placement || '',
    source: row.source || fallback.source || 'api',
    lastUpdated: row.updated_at || row.updatedAt || row.last_updated || nowIso(),
  };
}

function metricsMapFromZoneStats(rows = [], platform) {
  const map = new Map();
  for (const raw of rows) {
    const zoneId = String(getGroupValue(raw, ['zone', 'placement']) || raw.zone_id || raw.placement_id || raw.placement || '').trim();
    const zoneName = getGroupName(raw, ['zone', 'placement']);
    const metrics = normalizeMetrics(raw);
    if (zoneId) map.set(zoneId, metrics);
    if (zoneName) map.set(zoneName, metrics);
    if (!zoneId && !zoneName) map.set(`${platform}-${map.size}`, metrics);
  }
  return map;
}

function providerFilterParams(query = {}, platform = PLATFORM_EXOCLICK) {
  const country = String(query.country || '').trim().toUpperCase();
  const device = String(query.device || '').trim();
  const browser = String(query.browser || '').trim();
  const operatingSystem = String(query.operatingSystem || query.os || '').trim();

  if (platform === PLATFORM_ADSTERRA) {
    return {
      ...(country ? { country } : {}),
      ...(device ? { device } : {}),
      ...(browser ? { browser } : {}),
      ...(operatingSystem ? { os: operatingSystem } : {}),
    };
  }

  return {
    ...(country ? { country } : {}),
    ...(device ? { devices: device } : {}),
    ...(browser ? { browsers: browser } : {}),
    ...(operatingSystem ? { os: operatingSystem } : {}),
  };
}

function exoStatsParams(range, extra = {}, filters = {}) {
  return {
    'date-from': range.fromDate,
    'date-to': range.toDate,
    include: ['totals', 'count'],
    limit: extra.limit || 500,
    offset: extra.offset || 0,
    orderBy: extra.orderBy || 'd:revenue',
    ...providerFilterParams(filters, PLATFORM_EXOCLICK),
    ...extra,
  };
}

async function fetchExoClickBundle(range, filters = {}) {
  if (!configured(PLATFORM_EXOCLICK)) {
    return providerUnavailable(PLATFORM_EXOCLICK, 'EXOCLICK_API_KEY is not configured.', 'MISSING_KEY');
  }

  const today = todayRange();
  const yesterday = yesterdayRange();
  const month = monthRange();
  const tasks = await Promise.allSettled([
    exoGet('/statistics/p/date', exoStatsParams(range, {}, filters)),
    exoGet('/statistics/p/hour', exoStatsParams(today, { timezone: TZ, orderBy: 'a:hour' }, filters)),
    exoGet('/statistics/p/zone', exoStatsParams(range, { detailed: true, limit: 1000 }, filters)),
    exoGet('/statistics/p/country', exoStatsParams(range, { limit: 1000 }, filters)),
    exoGet('/statistics/p/device', exoStatsParams(range, { limit: 1000 }, filters)),
    exoGet('/statistics/p/browser', exoStatsParams(range, { limit: 1000 }, filters)),
    exoGet('/statistics/p/os', exoStatsParams(range, { limit: 1000 }, filters)),
    exoGet('/statistics/p/date', exoStatsParams(today, { limit: 50 }, filters)),
    exoGet('/statistics/p/date', exoStatsParams(yesterday, { limit: 50 }, filters)),
    exoGet('/statistics/p/date', exoStatsParams(month, { limit: 500 }, filters)),
    exoGet('/zones', { limit: 1000, offset: 0, status: 'all', include_deleted: false }),
  ]);

  return normalizeProviderBundle(PLATFORM_EXOCLICK, tasks, {
    dateIndex: 0,
    hourIndex: 1,
    zoneStatsIndex: 2,
    countryIndex: 3,
    deviceIndex: 4,
    browserIndex: 5,
    osIndex: 6,
    todayIndex: 7,
    yesterdayIndex: 8,
    monthIndex: 9,
    zonesIndex: 10,
  });
}

function adsterraParams(range, extra = {}, filters = {}) {
  return {
    start_date: range.fromDate,
    finish_date: range.toDate,
    ...providerFilterParams(filters, PLATFORM_ADSTERRA),
    ...extra,
  };
}

async function maybeAdsterra(path, params) {
  try {
    return await adsterraGet(path, params);
  } catch (err) {
    if (err instanceof AdsProviderError && [404, 405, 422].includes(err.status)) {
      return { result: [], degraded: true, message: err.message };
    }
    throw err;
  }
}

async function fetchAdsterraBundle(range, filters = {}) {
  if (!configured(PLATFORM_ADSTERRA)) {
    return providerUnavailable(PLATFORM_ADSTERRA, 'ADSTERRA_API_KEY is not configured.', 'MISSING_KEY');
  }

  const today = todayRange();
  const yesterday = yesterdayRange();
  const month = monthRange();
  const tasks = await Promise.allSettled([
    adsterraGet('/stats.json', adsterraParams(range, { group_by: 'date' }, filters)),
    adsterraGet('/stats.json', adsterraParams(today, { group_by: 'hour' }, filters)),
    adsterraGet('/stats.json', adsterraParams(range, { group_by: 'placement' }, filters)),
    adsterraGet('/stats.json', adsterraParams(range, { group_by: 'country' }, filters)),
    maybeAdsterra('/stats.json', adsterraParams(range, { group_by: 'device' }, filters)),
    maybeAdsterra('/stats.json', adsterraParams(range, { group_by: 'browser' }, filters)),
    maybeAdsterra('/stats.json', adsterraParams(range, { group_by: 'os' }, filters)),
    adsterraGet('/stats.json', adsterraParams(today, { group_by: 'date' }, filters)),
    adsterraGet('/stats.json', adsterraParams(yesterday, { group_by: 'date' }, filters)),
    adsterraGet('/stats.json', adsterraParams(month, { group_by: 'date' }, filters)),
    maybeAdsterra('/placements.json', {}),
    maybeAdsterra('/domains.json', {}),
    maybeAdsterra('/smartlinks.json', {}),
  ]);

  return normalizeProviderBundle(PLATFORM_ADSTERRA, tasks, {
    dateIndex: 0,
    hourIndex: 1,
    zoneStatsIndex: 2,
    countryIndex: 3,
    deviceIndex: 4,
    browserIndex: 5,
    osIndex: 6,
    todayIndex: 7,
    yesterdayIndex: 8,
    monthIndex: 9,
    zonesIndex: 10,
    domainsIndex: 11,
    smartlinksIndex: 12,
  });
}

function resultOrRows(tasks, index) {
  const result = tasks[index];
  if (!result || result.status !== 'fulfilled') return [];
  return extractRows(result.value);
}

function taskErrors(tasks, platform) {
  return tasks
    .map((task) => task.status === 'rejected' ? normalizeProviderError(task.reason, platform) : null)
    .filter(Boolean);
}

function normalizeProviderError(err, platform) {
  if (err instanceof AdsProviderError) {
    return {
      platform,
      code: err.code,
      status: err.status,
      message: err.message,
      retryAfterMs: err.retryAfterMs || 0,
    };
  }
  return {
    platform,
    code: 'API_ERROR',
    status: 0,
    message: err?.message || String(err || 'Unknown provider error'),
    retryAfterMs: 0,
  };
}

function providerUnavailable(platform, message, code = 'API_UNAVAILABLE') {
  return {
    platform,
    configured: configured(platform),
    ok: false,
    status: code === 'MISSING_KEY' ? 'not_configured' : 'unavailable',
    errors: [{ platform, code, status: 0, message, retryAfterMs: 0 }],
    summary: emptySummary(),
    timeline: [],
    hourly: [],
    zones: platform === PLATFORM_EXOCLICK ? getCodeManagedExoZones() : CODE_MANAGED_ADSTERRA_ZONES.map((zone) => normalizeZoneRow(zone, platform)),
    countries: [],
    devices: [],
    browsers: [],
    operatingSystems: [],
    rawUpdatedAt: nowIso(),
  };
}

function normalizeProviderBundle(platform, tasks, indexes) {
  const dateRows = resultOrRows(tasks, indexes.dateIndex);
  const hourlyRows = resultOrRows(tasks, indexes.hourIndex);
  const zoneStatsRows = resultOrRows(tasks, indexes.zoneStatsIndex);
  const countryRows = resultOrRows(tasks, indexes.countryIndex);
  const deviceRows = resultOrRows(tasks, indexes.deviceIndex);
  const browserRows = resultOrRows(tasks, indexes.browserIndex);
  const osRows = resultOrRows(tasks, indexes.osIndex);
  const todayRows = resultOrRows(tasks, indexes.todayIndex);
  const yesterdayRows = resultOrRows(tasks, indexes.yesterdayIndex);
  const monthRows = resultOrRows(tasks, indexes.monthIndex);
  const apiZoneRows = resultOrRows(tasks, indexes.zonesIndex);
  const domainRows = indexes.domainsIndex != null ? resultOrRows(tasks, indexes.domainsIndex) : [];
  const smartlinkRows = indexes.smartlinksIndex != null ? resultOrRows(tasks, indexes.smartlinksIndex) : [];
  const errors = taskErrors(tasks, platform);
  const fatalErrors = errors.filter((err) => ['AUTH_FAILED', 'MISSING_KEY', 'RATE_LIMITED', 'API_UNAVAILABLE', 'TIMEOUT'].includes(err.code));

  const zoneMetrics = metricsMapFromZoneStats(zoneStatsRows, platform);
  const zones = normalizeProviderZones(platform, apiZoneRows, domainRows, smartlinkRows, zoneMetrics);
  const summary = summarizeRows(dateRows);
  summary.todayRevenue = summarizeRows(todayRows).totalRevenue;
  summary.yesterdayRevenue = summarizeRows(yesterdayRows).totalRevenue;
  summary.monthlyRevenue = summarizeRows(monthRows).totalRevenue;
  summary.activeZones = zones.filter((zone) => zone.status === 'active').length;
  summary.activeCampaigns = safeNumber(apiZoneRows.filter((row) => /campaign/i.test(String(row.type || row.kind || '')) && String(row.status || '').toLowerCase() === 'active').length);

  return {
    platform,
    configured: configured(platform),
    ok: fatalErrors.length === 0,
    status: fatalErrors.length ? fatalErrors[0].code.toLowerCase() : 'ok',
    errors,
    summary: roundSummary(summary),
    timeline: dateRows.map((row) => normalizeTimeRow(row, platform, 'date')),
    hourly: hourlyRows.map((row) => normalizeTimeRow(row, platform, 'hour')),
    zones,
    countries: countryRows.map((row) => ({ ...normalizeMetrics(row), name: getGroupName(row, ['country']) || 'Unknown', code: String(getGroupValue(row, ['country']) || '') })),
    devices: deviceRows.map((row) => ({ ...normalizeMetrics(row), name: getGroupName(row, ['device']) || 'Unknown' })),
    browsers: browserRows.map((row) => ({ ...normalizeMetrics(row), name: getGroupName(row, ['browser']) || 'Unknown' })),
    operatingSystems: osRows.map((row) => ({ ...normalizeMetrics(row), name: getGroupName(row, ['os', 'operating_system']) || 'Unknown' })),
    rawUpdatedAt: nowIso(),
  };
}

function getCodeManagedExoZones() {
  return [
    {
      id: 'exoclick-vast-preroll-5963164',
      zoneName: 'Video In-Stream Pre-roll',
      zoneId: EXOCLICK_VAST_ZONE_ID,
      platform: PLATFORM_EXOCLICK,
      adFormat: 'In-Stream',
      status: 'active',
      width: null,
      height: null,
      placement: 'video_preroll',
      source: 'code',
      tagUrl: EXOCLICK_VAST_TAG_URL,
    },
    {
      id: 'exoclick-display-5933054',
      zoneName: 'Display Banner Rotation',
      zoneId: EXOCLICK_DISPLAY_ZONE_ID,
      platform: PLATFORM_EXOCLICK,
      adFormat: 'Banner',
      status: 'active',
      width: 728,
      height: 90,
      placement: 'leaderboard',
      source: 'code',
      tagUrl: EXOCLICK_DISPLAY_SCRIPT_URL,
    },
  ].map((zone) => normalizeZoneRow(zone, PLATFORM_EXOCLICK));
}

function normalizeProviderZones(platform, zoneRows, domainRows, smartlinkRows, metricsByZone) {
  const rows = [];
  if (platform === PLATFORM_EXOCLICK) {
    for (const zone of zoneRows) rows.push(normalizeZoneRow(zone, platform, metricsByZone));
    for (const zone of getCodeManagedExoZones()) rows.push(mergeZoneMetrics(zone, metricsByZone));
  } else {
    for (const zone of zoneRows) rows.push(normalizeZoneRow(zone, platform, metricsByZone, { adFormat: 'Banner' }));
    for (const domain of domainRows) {
      if (!zoneRows.length) rows.push(normalizeZoneRow(domain, platform, metricsByZone, { adFormat: 'Banner', zoneName: domain.domain || domain.name }));
    }
    for (const link of smartlinkRows) rows.push(normalizeZoneRow(link, platform, metricsByZone, { adFormat: 'Smartlink' }));
    for (const zone of CODE_MANAGED_ADSTERRA_ZONES) rows.push(mergeZoneMetrics(normalizeZoneRow(zone, platform), metricsByZone));
  }

  const byKey = new Map();
  for (const zone of rows) {
    const key = `${zone.platform}:${zone.zoneId || zone.zoneName}:${zone.placement || ''}`;
    const existing = byKey.get(key);
    if (!existing || existing.source !== 'api') byKey.set(key, zone);
  }
  return Array.from(byKey.values()).sort((a, b) => `${a.platform}:${a.zoneName}`.localeCompare(`${b.platform}:${b.zoneName}`));
}

function mergeZoneMetrics(zone, metricsByZone) {
  const metrics = metricsByZone.get(zone.zoneId) || metricsByZone.get(zone.zoneName);
  if (!metrics) return zone;
  return {
    ...zone,
    revenue: round(metrics.revenue),
    impressions: Math.round(metrics.impressions),
    clicks: Math.round(metrics.clicks),
    adRequests: Math.round(metrics.adRequests),
    cpm: round(metrics.cpm),
    cpc: round(metrics.cpc, 4),
    ctr: round(metrics.ctr),
    fillRate: round(metrics.fillRate),
  };
}

function mergeTimeSeries(providerBundles, sourceKey = 'timeline') {
  const byKey = new Map();
  for (const bundle of providerBundles) {
    for (const row of bundle[sourceKey] || []) {
      const key = row.key || row.label;
      if (!byKey.has(key)) byKey.set(key, { key, label: row.label || key, exoclick: 0, adsterra: 0, combined: 0, impressions: 0, clicks: 0, cpm: 0, ctr: 0 });
      const target = byKey.get(key);
      const revenue = safeNumber(row.metrics?.revenue);
      target[row.platform] += revenue;
      target.combined += revenue;
      target.impressions += safeNumber(row.metrics?.impressions);
      target.clicks += safeNumber(row.metrics?.clicks);
    }
  }
  const rows = Array.from(byKey.values()).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return rows.map((row) => ({
    ...row,
    exoclick: round(row.exoclick),
    adsterra: round(row.adsterra),
    combined: round(row.combined),
    cpm: row.impressions ? round((row.combined / row.impressions) * 1000) : 0,
    ctr: row.impressions ? round((row.clicks / row.impressions) * 100) : 0,
  }));
}

function aggregateBy(rows, makeKey, makeLabel) {
  const byKey = new Map();
  for (const row of rows) {
    const key = makeKey(row);
    if (!byKey.has(key)) byKey.set(key, { key, label: makeLabel(row), exoclick: 0, adsterra: 0, combined: 0, impressions: 0, clicks: 0 });
    const target = byKey.get(key);
    target.exoclick += safeNumber(row.exoclick);
    target.adsterra += safeNumber(row.adsterra);
    target.combined += safeNumber(row.combined);
    target.impressions += safeNumber(row.impressions);
    target.clicks += safeNumber(row.clicks);
  }
  return Array.from(byKey.values()).sort((a, b) => String(a.key).localeCompare(String(b.key))).map((row) => ({
    ...row,
    exoclick: round(row.exoclick),
    adsterra: round(row.adsterra),
    combined: round(row.combined),
    cpm: row.impressions ? round((row.combined / row.impressions) * 1000) : 0,
    ctr: row.impressions ? round((row.clicks / row.impressions) * 100) : 0,
  }));
}

function weekKey(dateString) {
  const date = safeDate(dateString);
  const first = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date - first) / 86400000);
  const week = Math.ceil((days + first.getDay() + 1) / 7);
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function buildCharts(providerBundles) {
  const daily = mergeTimeSeries(providerBundles, 'timeline');
  const hourly = mergeTimeSeries(providerBundles, 'hourly');
  const weekly = aggregateBy(daily, (row) => weekKey(row.key), (row) => weekKey(row.key));
  const monthly = aggregateBy(daily, (row) => String(row.key).slice(0, 7), (row) => String(row.key).slice(0, 7));
  const yearly = aggregateBy(daily, (row) => String(row.key).slice(0, 4), (row) => String(row.key).slice(0, 4));
  return {
    hourlyRevenue: hourly,
    dailyRevenue: daily,
    weeklyRevenue: weekly,
    monthlyRevenue: monthly,
    yearlyRevenue: yearly,
    revenueComparison: daily,
    cpmComparison: daily.map((row) => ({ key: row.key, label: row.label, combined: row.cpm, exoclick: row.impressions ? row.exoclick / row.impressions * 1000 : 0, adsterra: row.impressions ? row.adsterra / row.impressions * 1000 : 0 })),
    ctrComparison: daily.map((row) => ({ key: row.key, label: row.label, combined: row.ctr, exoclick: row.ctr, adsterra: row.ctr })),
    impressionTrends: daily.map((row) => ({ key: row.key, label: row.label, impressions: row.impressions })),
    clickTrends: daily.map((row) => ({ key: row.key, label: row.label, clicks: row.clicks })),
  };
}

function combineSummaries(providerBundles) {
  const combined = emptySummary();
  for (const bundle of providerBundles) {
    for (const key of ['todayRevenue', 'yesterdayRevenue', 'monthlyRevenue', 'totalRevenue', 'estimatedRevenue', 'impressions', 'clicks', 'adRequests', 'activeZones', 'activeCampaigns']) {
      combined[key] += safeNumber(bundle.summary?.[key]);
    }
  }
  combined.cpm = combined.impressions ? (combined.totalRevenue / combined.impressions) * 1000 : 0;
  combined.cpc = combined.clicks ? combined.totalRevenue / combined.clicks : 0;
  combined.ctr = combined.impressions ? (combined.clicks / combined.impressions) * 100 : 0;
  combined.fillRate = combined.adRequests ? (combined.impressions / combined.adRequests) * 100 : (combined.impressions ? 100 : 0);
  return roundSummary(combined);
}

function dimensionRows(providerBundles, key) {
  const byName = new Map();
  for (const bundle of providerBundles) {
    for (const row of bundle[key] || []) {
      const name = row.name || row.code || 'Unknown';
      const mapKey = `${bundle.platform}:${name}`;
      byName.set(mapKey, {
        ...row,
        platform: bundle.platform,
        revenue: round(row.revenue),
        impressions: Math.round(row.impressions),
        clicks: Math.round(row.clicks),
      });
    }
  }
  return Array.from(byName.values()).sort((a, b) => safeNumber(b.revenue) - safeNumber(a.revenue));
}

function buildPerformance(providerBundles, zones) {
  const sortedRevenue = [...zones].sort((a, b) => safeNumber(b.revenue) - safeNumber(a.revenue));
  const sortedCpm = [...zones].sort((a, b) => safeNumber(b.cpm) - safeNumber(a.cpm));
  const sortedCtr = [...zones].sort((a, b) => safeNumber(b.ctr) - safeNumber(a.ctr));
  const formats = new Map();
  for (const zone of zones) {
    const key = zone.adFormat || 'Unknown';
    if (!formats.has(key)) formats.set(key, { name: key, revenue: 0, impressions: 0, clicks: 0, zones: 0 });
    const item = formats.get(key);
    item.revenue += safeNumber(zone.revenue);
    item.impressions += safeNumber(zone.impressions);
    item.clicks += safeNumber(zone.clicks);
    item.zones += 1;
  }
  const formatRows = Array.from(formats.values()).map((row) => ({
    ...row,
    revenue: round(row.revenue),
    cpm: row.impressions ? round((row.revenue / row.impressions) * 1000) : 0,
    ctr: row.impressions ? round((row.clicks / row.impressions) * 100) : 0,
  })).sort((a, b) => b.revenue - a.revenue);

  return {
    highestRevenueZone: sortedRevenue[0] || null,
    lowestRevenueZone: sortedRevenue.filter((zone) => safeNumber(zone.revenue) > 0).at(-1) || sortedRevenue.at(-1) || null,
    bestPerformingAdFormat: formatRows[0] || null,
    worstPerformingAdFormat: formatRows.at(-1) || null,
    topCpm: sortedCpm[0] || null,
    topCtr: sortedCtr[0] || null,
    fillRateStatistics: {
      average: zones.length ? round(zones.reduce((sum, zone) => sum + safeNumber(zone.fillRate), 0) / zones.length) : 0,
      best: [...zones].sort((a, b) => safeNumber(b.fillRate) - safeNumber(a.fillRate))[0] || null,
      weakest: [...zones].sort((a, b) => safeNumber(a.fillRate) - safeNumber(b.fillRate))[0] || null,
    },
    revenueByCountry: dimensionRows(providerBundles, 'countries'),
    revenueByDevice: dimensionRows(providerBundles, 'devices'),
    revenueByBrowser: dimensionRows(providerBundles, 'browsers'),
    revenueByOperatingSystem: dimensionRows(providerBundles, 'operatingSystems'),
    adFormats: formatRows,
  };
}

async function getCodeManagedZoneRows() {
  try {
    const [providers, zones] = await Promise.all([listProviders(), listCodeManagedZones()]);
    const providerById = new Map((providers || []).map((provider) => [provider.id, provider]));
    return (zones || []).map((zone) => {
      const provider = providerById.get(zone.provider_id) || {};
      const platform = String(provider.slug || zone.provider_id || '').toLowerCase() === PLATFORM_EXOCLICK
        ? PLATFORM_EXOCLICK
        : null;
      if (!platform) return null;
      return normalizeZoneRow({
        ...zone,
        id: zone.id || `${platform}-${zone.placement}-${zone.zone_id}`,
        zoneName: zone.name || `${provider.name || platform} ${zone.placement}`,
        zoneId: zone.zone_id,
        adFormat: zone.placement === 'video_preroll' ? 'In-Stream' : detectFormat(zone, 'Banner'),
        status: zone.is_active === false ? 'inactive' : 'active',
        source: 'code',
      }, platform);
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function buildNotifications(providerBundles, summary, zones) {
  const notices = [];
  for (const bundle of providerBundles) {
    for (const err of bundle.errors || []) {
      if (err.code === 'AUTH_FAILED') {
        notices.push({ level: 'critical', platform: bundle.platform, title: 'API authentication failed', message: err.message });
      } else if (err.code === 'RATE_LIMITED') {
        notices.push({ level: 'warning', platform: bundle.platform, title: 'Rate limit reached', message: err.retryAfterMs ? `Provider asked us to retry after ${Math.ceil(err.retryAfterMs / 1000)} seconds.` : err.message });
      } else if (['API_UNAVAILABLE', 'TIMEOUT', 'API_ERROR'].includes(err.code)) {
        notices.push({ level: 'warning', platform: bundle.platform, title: 'API unavailable', message: err.message });
      } else if (err.code === 'MISSING_KEY') {
        notices.push({ level: 'critical', platform: bundle.platform, title: 'API key missing', message: err.message });
      }
    }
  }

  if (summary.yesterdayRevenue > 0 && summary.todayRevenue < summary.yesterdayRevenue * 0.7) {
    notices.push({
      level: 'warning',
      platform: 'combined',
      title: 'Revenue dropped significantly',
      message: `Today is ${round((summary.todayRevenue / summary.yesterdayRevenue) * 100)}% of yesterday's revenue.`,
    });
  }

  for (const zone of zones.filter((item) => item.status && !['active', 'approved', 'running', 'true', '1'].includes(String(item.status).toLowerCase())).slice(0, 5)) {
    notices.push({
      level: 'info',
      platform: zone.platform,
      title: 'Zone inactive',
      message: `${zone.zoneName} is marked ${zone.status}.`,
    });
  }

  if (!notices.length) {
    notices.push({
      level: 'success',
      platform: 'combined',
      title: 'Ads analytics synchronized',
      message: 'Both provider adapters completed with cached, normalized analytics available to administrators.',
    });
  }
  return notices;
}

function settingsPayload(providerBundles = []) {
  const statusByProvider = new Map(providerBundles.map((bundle) => [bundle.platform, bundle.status]));
  return {
    cacheTtlSeconds: Math.round(CACHE_TTL_MS / 1000),
    timezone: TZ,
    providers: {
      exoclick: {
        configured: configured(PLATFORM_EXOCLICK),
        status: statusByProvider.get(PLATFORM_EXOCLICK) || (configured(PLATFORM_EXOCLICK) ? 'pending' : 'not_configured'),
        apiBase: EXOCLICK_API_BASE,
        supportedFormats: SUPPORTED_AD_FORMATS.exoclick,
      },
      adsterra: {
        configured: configured(PLATFORM_ADSTERRA),
        status: statusByProvider.get(PLATFORM_ADSTERRA) || (configured(PLATFORM_ADSTERRA) ? 'pending' : 'not_configured'),
        apiBase: ADSTERRA_API_BASE,
        supportedFormats: SUPPORTED_AD_FORMATS.adsterra,
      },
    },
    secretsExposed: false,
    exports: ['csv', 'excel', 'pdf'],
  };
}

function cacheKey(prefix, query = {}) {
  const range = resolveAdsDateRange(query);
  const platform = String(query.platform || 'combined').toLowerCase();
  const filters = [
    query.country || '',
    query.device || '',
    query.browser || '',
    query.operatingSystem || query.os || '',
  ].map((value) => String(value).trim().toLowerCase()).join(':');
  return `${prefix}:${platform}:${range.preset}:${range.fromDate}:${range.toDate}:${filters}`;
}

async function loadAdsData(query = {}) {
  const range = resolveAdsDateRange(query);
  const platform = String(query.platform || 'combined').toLowerCase();
  const providerFilters = {
    country: query.country,
    device: query.device,
    browser: query.browser,
    operatingSystem: query.operatingSystem || query.os,
  };
  const wanted = platform === PLATFORM_EXOCLICK
    ? [PLATFORM_EXOCLICK]
    : platform === PLATFORM_ADSTERRA
      ? [PLATFORM_ADSTERRA]
      : PROVIDERS;

  const bundles = await Promise.all(wanted.map((name) => (
    name === PLATFORM_EXOCLICK ? fetchExoClickBundle(range, providerFilters) : fetchAdsterraBundle(range, providerFilters)
  )));

  const codeZones = await getCodeManagedZoneRows();
  const zones = [...bundles.flatMap((bundle) => bundle.zones || []), ...codeZones];
  const dedupedZones = Array.from(new Map(zones.map((zone) => [`${zone.platform}:${zone.zoneId || zone.zoneName}:${zone.placement}`, zone])).values());
  const summary = combineSummaries(bundles);
  summary.activeZones = dedupedZones.filter((zone) => String(zone.status).toLowerCase() === 'active').length;
  const charts = buildCharts(bundles);
  const performance = buildPerformance(bundles, dedupedZones);
  const notifications = buildNotifications(bundles, summary, dedupedZones);

  return {
    success: true,
    generatedAt: nowIso(),
    range: {
      preset: range.preset,
      from: range.fromDate,
      to: range.toDate,
      timezone: TZ,
    },
    summary,
    providers: Object.fromEntries(bundles.map((bundle) => [bundle.platform, {
      configured: bundle.configured,
      ok: bundle.ok,
      status: bundle.status,
      summary: bundle.summary,
      errors: bundle.errors,
      updatedAt: bundle.rawUpdatedAt,
    }])),
    charts,
    zones: dedupedZones,
    performance,
    notifications,
    settings: settingsPayload(bundles),
  };
}

export async function getAdsAnalyticsData(query = {}) {
  return appMemoryCache.wrap(cacheKey('ads-analytics', query), () => loadAdsData(query), CACHE_TTL_MS);
}

export async function getAdsOverview(query = {}) {
  const data = await getAdsAnalyticsData(query);
  return {
    ...data,
    zones: data.zones.slice(0, 12),
  };
}

export async function getAdsRevenue(query = {}) {
  const data = await getAdsAnalyticsData(query);
  return {
    success: true,
    generatedAt: data.generatedAt,
    range: data.range,
    summary: data.summary,
    providers: data.providers,
    charts: data.charts,
    notifications: data.notifications,
  };
}

function filterZones(zones, query = {}) {
  const platform = String(query.platform || 'combined').toLowerCase();
  const format = String(query.adFormat || query.format || '').toLowerCase();
  const status = String(query.status || '').toLowerCase();
  const search = String(query.search || '').toLowerCase();
  return zones.filter((zone) => {
    if (platform !== 'combined' && platform && zone.platform !== platform) return false;
    if (format && !String(zone.adFormat || '').toLowerCase().includes(format)) return false;
    if (status && String(zone.status || '').toLowerCase() !== status) return false;
    if (search) {
      const haystack = `${zone.zoneName} ${zone.zoneId} ${zone.platform} ${zone.adFormat} ${zone.placement}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function sortRows(rows, sortBy = 'revenue', direction = 'desc') {
  const dir = String(direction).toLowerCase() === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (typeof av === 'number' || typeof bv === 'number') return (safeNumber(av) - safeNumber(bv)) * dir;
    return String(av || '').localeCompare(String(bv || '')) * dir;
  });
}

export async function getAdsZones(query = {}) {
  const data = await getAdsAnalyticsData(query);
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(5, Number(query.limit || 20)));
  const filtered = filterZones(data.zones, query);
  const sorted = sortRows(filtered, query.sortBy || 'revenue', query.sortDirection || 'desc');
  const start = (page - 1) * limit;
  return {
    success: true,
    generatedAt: data.generatedAt,
    range: data.range,
    zones: sorted.slice(start, start + limit),
    total: sorted.length,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(sorted.length / limit)),
    filters: {
      platform: query.platform || 'combined',
      adFormat: query.adFormat || '',
      status: query.status || '',
      search: query.search || '',
      sortBy: query.sortBy || 'revenue',
      sortDirection: query.sortDirection || 'desc',
    },
  };
}

export async function getAdsPerformance(query = {}) {
  const data = await getAdsAnalyticsData(query);
  return {
    success: true,
    generatedAt: data.generatedAt,
    range: data.range,
    performance: data.performance,
    notifications: data.notifications,
  };
}

export async function getAdsReport(query = {}) {
  const data = await getAdsAnalyticsData(query);
  const zones = sortRows(filterZones(data.zones, query), query.sortBy || 'revenue', query.sortDirection || 'desc');
  return {
    success: true,
    generatedAt: data.generatedAt,
    range: data.range,
    filters: {
      platform: query.platform || 'combined',
      adFormat: query.adFormat || '',
      country: query.country || '',
      device: query.device || '',
      browser: query.browser || '',
      operatingSystem: query.operatingSystem || '',
    },
    summary: data.summary,
    providers: data.providers,
    zones,
    charts: data.charts,
    performance: data.performance,
    notifications: data.notifications,
  };
}

export async function getAdsSettings(query = {}) {
  const data = await getAdsAnalyticsData(query);
  return {
    success: true,
    generatedAt: data.generatedAt,
    settings: data.settings,
    notifications: data.notifications,
  };
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function reportToCsv(report) {
  const headers = ['Zone Name', 'Zone ID', 'Platform', 'Ad Format', 'Status', 'Revenue', 'Impressions', 'Clicks', 'CPM', 'CTR', 'Fill Rate', 'Last Updated'];
  const rows = (report.zones || []).map((zone) => [
    zone.zoneName,
    zone.zoneId,
    zone.platform,
    zone.adFormat,
    zone.status,
    zone.revenue,
    zone.impressions,
    zone.clicks,
    zone.cpm,
    zone.ctr,
    zone.fillRate,
    zone.lastUpdated,
  ]);
  return [headers.map(csvEscape).join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n');
}

export function reportToExcelXml(report) {
  const rows = reportToCsv(report).split('\n').map((line) => {
    const cells = line.match(/("([^"]|"")*"|[^,]+)/g) || [];
    return `<Row>${cells.map((cell) => `<Cell><Data ss:Type="String">${String(cell).replace(/^"|"$/g, '').replace(/""/g, '"').replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]))}</Data></Cell>`).join('')}</Row>`;
  }).join('');
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="Ads Report">
    <Table>${rows}</Table>
  </Worksheet>
</Workbook>`;
}

export function streamReportPdf(res, report) {
  const doc = new PDFDocument({ margin: 42, size: 'A4', autoFirstPage: true });
  doc.pipe(res);
  doc.fontSize(18).text('Xstream Ads Management Report', { align: 'left' });
  doc.moveDown(0.4);
  doc.fontSize(9).fillColor('#666').text(`Generated: ${report.generatedAt}`);
  doc.text(`Range: ${report.range.from} to ${report.range.to} (${report.range.timezone})`);
  doc.moveDown();
  doc.fillColor('#111').fontSize(11).text('Summary', { underline: true });
  const summaryRows = [
    ['Total Revenue', `$${round(report.summary.totalRevenue).toFixed(2)}`],
    ['Estimated Revenue', `$${round(report.summary.estimatedRevenue).toFixed(2)}`],
    ['Impressions', String(report.summary.impressions)],
    ['Clicks', String(report.summary.clicks)],
    ['Average CPM', `$${round(report.summary.cpm).toFixed(2)}`],
    ['Average CTR', `${round(report.summary.ctr).toFixed(2)}%`],
    ['Active Zones', String(report.summary.activeZones)],
  ];
  for (const [label, value] of summaryRows) doc.fontSize(10).text(`${label}: ${value}`);
  doc.moveDown();
  doc.fontSize(11).text('Top Zones', { underline: true });
  for (const zone of (report.zones || []).slice(0, 18)) {
    doc.fontSize(9).text(`${zone.platform.toUpperCase()} | ${zone.zoneName} | ${zone.adFormat} | $${round(zone.revenue).toFixed(2)} | ${zone.impressions} impressions`);
  }
  doc.end();
}
