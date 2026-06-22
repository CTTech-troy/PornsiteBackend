import {
  createEmptyAnalyticsOverview,
  getAnalyticsOverview,
  getRealtimeAnalytics,
  refreshAnalyticsDailySummary,
} from '../services/analytics.service.js';

const OVERVIEW_TIMEOUT = Symbol('admin_analytics_overview_timeout');
const ADMIN_ANALYTICS_RESPONSE_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.ADMIN_ANALYTICS_RESPONSE_TIMEOUT_MS || 12000),
);
const OVERVIEW_CACHE_TTL_MS = Math.max(
  30000,
  Number(process.env.ADMIN_ANALYTICS_OVERVIEW_CACHE_TTL_MS || 5 * 60 * 1000),
);

let overviewCache = null;

function overviewCacheKey(query = {}) {
  const range = String(query.range || '30d').toLowerCase();
  const granularity = String(query.granularity || '').toLowerCase();
  const from = query.from ? String(query.from) : '';
  const to = query.to ? String(query.to) : '';
  return JSON.stringify({ range, granularity, from, to });
}

function getCachedOverview(query = {}) {
  if (!overviewCache) return null;
  if (overviewCache.key !== overviewCacheKey(query)) return null;
  if (Date.now() - overviewCache.cachedAt > OVERVIEW_CACHE_TTL_MS) return null;
  return overviewCache.payload;
}

function cacheOverview(query = {}, payload) {
  overviewCache = {
    key: overviewCacheKey(query),
    cachedAt: Date.now(),
    payload,
  };
}

function staleOverview(payload, reason) {
  return {
    ...payload,
    success: true,
    degraded: true,
    stale: true,
    message: reason,
    sources: {
      ...(payload?.sources || {}),
      degraded: true,
      stale: true,
      reason,
    },
  };
}

async function withResponseTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(OVERVIEW_TIMEOUT), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function getOverview(req, res) {
  try {
    const payload = await withResponseTimeout(
      getAnalyticsOverview(req.query || {}),
      ADMIN_ANALYTICS_RESPONSE_TIMEOUT_MS,
    );
    if (payload === OVERVIEW_TIMEOUT) {
      console.warn('[adminAnalytics] overview timed out; returning degraded response', {
        timeoutMs: ADMIN_ANALYTICS_RESPONSE_TIMEOUT_MS,
      });
      const cached = getCachedOverview(req.query || {});
      if (cached) {
        return res.json(staleOverview(
          cached,
          'Analytics is still loading. Showing the latest cached analytics snapshot.',
        ));
      }
      return res.json({
        success: true,
        ...createEmptyAnalyticsOverview(
          req.query || {},
          'Analytics is still loading. Showing a temporary safe fallback instead of failing the dashboard.',
        ),
      });
    }
    cacheOverview(req.query || {}, payload);
    return res.json({ success: true, ...payload });
  } catch (err) {
    console.error('adminAnalytics.getOverview', err?.message || err);
    const cached = getCachedOverview(req.query || {});
    if (cached) {
      return res.json(staleOverview(
        cached,
        err?.message || 'Analytics is temporarily unavailable. Showing the latest cached analytics snapshot.',
      ));
    }
    return res.json({
      success: true,
      ...createEmptyAnalyticsOverview(
        req.query || {},
        err?.message || 'Analytics is temporarily unavailable. Showing a safe fallback.',
      ),
    });
  }
}

export async function getRealtime(req, res) {
  try {
    const realtime = await getRealtimeAnalytics();
    return res.json({ success: true, realtime });
  } catch (err) {
    console.error('adminAnalytics.getRealtime', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to load realtime analytics' });
  }
}

export async function postRefreshSummary(req, res) {
  try {
    const result = await refreshAnalyticsDailySummary({ ...req.query, ...(req.body || {}) });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('adminAnalytics.postRefreshSummary', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to refresh analytics summary' });
  }
}
