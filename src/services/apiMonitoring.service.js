import crypto from 'crypto';
import os from 'os';
import {
  isSupabaseNetworkError,
  markSupabaseUnavailable,
  supabase,
} from '../config/supabase.js';
import { markRedisError, upstashRedis } from '../config/redis.js';
import { getMonitoringWorkflowUrl, getPublicBackendUrl, qstashClient } from '../config/qstash.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const STATUS_RANK = {
  healthy: 0,
  warning: 1,
  critical: 2,
  offline: 3,
};

const REDIS_EVENT_KEY = process.env.API_MONITOR_REDIS_EVENT_KEY || 'xstream:api-monitor:events';
const REDIS_OVERVIEW_KEY = process.env.API_MONITOR_REDIS_OVERVIEW_KEY || 'xstream:api-monitor:overview';
const REDIS_EVENTS_LIMIT = readPositiveInteger('API_MONITOR_REDIS_EVENTS_LIMIT', 50000);
const LOCAL_QUEUE_LIMIT = readPositiveInteger('API_MONITOR_LOCAL_QUEUE_LIMIT', 5000);
const RECENT_LOG_LIMIT = readPositiveInteger('API_MONITOR_RECENT_LOG_LIMIT', 500);
const REDIS_DRAIN_BATCH_SIZE = readPositiveInteger('API_MONITOR_REDIS_DRAIN_BATCH_SIZE', 1000);
const OVERVIEW_LOG_LIMIT = readPositiveInteger('API_MONITOR_OVERVIEW_LOG_LIMIT', 10000);
const DETAIL_LOG_LIMIT = readPositiveInteger('API_MONITOR_DETAIL_LOG_LIMIT', 2000);
const CACHE_TTL_SECONDS = readPositiveInteger('API_MONITOR_CACHE_TTL_SECONDS', 10);
const OFFLINE_AFTER_MS = readPositiveInteger('API_MONITOR_OFFLINE_AFTER_MS', 15 * 60 * 1000);
const HEALTH_CHECK_TIMEOUT_MS = readPositiveInteger('API_MONITOR_HEALTH_CHECK_TIMEOUT_MS', 8000);

const localQueue = [];
const recentLogs = [];
const memoryRoutes = new Map();
const serviceState = {
  startedAt: new Date().toISOString(),
  droppedEvents: 0,
  redisBufferedEvents: 0,
  redisWriteFailures: 0,
  dbWriteFailures: 0,
  lastRedisWriteAt: null,
  lastRedisErrorAt: null,
  lastRedisError: null,
  lastFlushAt: null,
  lastFlushErrorAt: null,
  lastFlushError: null,
  lastAggregationAt: null,
  lastAggregationErrorAt: null,
  lastAggregationError: null,
  lastIncidentScanAt: null,
  lastSummaryAt: null,
};

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function toIso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function rangeToStart(range = '24h') {
  const now = Date.now();
  const ranges = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  return new Date(now - (ranges[range] || ranges['24h']));
}

function safeJsonParse(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeDbError(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 500);
}

function isMissingMonitoringTable(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === '42P01' || code === 'PGRST200' || /schema cache|does not exist|api_request_logs|api_metric_rollups/i.test(message);
}

function hashIp(value) {
  const salt = process.env.API_MONITOR_IP_HASH_SECRET
    || process.env.ADMIN_JWT_SECRET
    || process.env.JWT_SECRET
    || 'development-monitoring-salt';
  return crypto.createHmac('sha256', salt).update(String(value || 'unknown')).digest('hex').slice(0, 32);
}

function normalizeSegment(segment) {
  const clean = String(segment || '').trim();
  if (!clean) return clean;
  if (/^\d+$/.test(clean)) return ':id';
  if (/^[0-9a-f]{24}$/i.test(clean)) return ':id';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)) return ':id';
  if (/^[A-Za-z0-9_-]{40,}$/.test(clean)) return ':token';
  return clean;
}

export function normalizeApiPath(value) {
  const rawPath = String(value || '/').split('?')[0] || '/';
  const normalized = rawPath
    .replace(/\/+/g, '/')
    .split('/')
    .map(normalizeSegment)
    .join('/');
  return normalized === '' ? '/' : normalized;
}

export function buildRouteKey(method, path) {
  return `${String(method || 'GET').toUpperCase()} ${normalizeApiPath(path)}`;
}

function groupFromPath(path) {
  const parts = normalizeApiPath(path).split('/').filter(Boolean);
  if (parts[0] === 'api' && parts[1]) return parts[1];
  return parts[0] || 'root';
}

function operationForMethod(method) {
  const normalized = String(method || 'GET').toUpperCase();
  if (READ_METHODS.has(normalized)) return 'read';
  if (WRITE_METHODS.has(normalized)) return 'write';
  return 'other';
}

function apiNameFor(method, path) {
  return `${String(method || 'GET').toUpperCase()} ${normalizeApiPath(path)}`;
}

function normalizeCapturedEvent(event) {
  const method = String(event.method || 'GET').toUpperCase();
  const endpoint = normalizeApiPath(event.endpoint || event.path || event.originalUrl || '/');
  const statusCode = Number(event.statusCode || event.status_code || 0);
  const latencyMs = Math.max(0, Math.round(Number(event.latencyMs || event.latency_ms || 0)));
  const operationType = event.operationType || event.operation_type || operationForMethod(method);
  const timestamp = event.timestamp || event.created_at || new Date().toISOString();

  return {
    requestId: String(event.requestId || event.request_id || crypto.randomUUID()),
    apiName: String(event.apiName || event.api_name || apiNameFor(method, endpoint)).slice(0, 240),
    routeKey: String(event.routeKey || event.route_key || buildRouteKey(method, endpoint)).slice(0, 260),
    routeGroup: String(event.routeGroup || event.route_group || groupFromPath(endpoint)).slice(0, 80),
    method,
    endpoint,
    statusCode,
    success: statusCode > 0 && statusCode < 400,
    latencyMs,
    requestBytes: Math.max(0, Number(event.requestBytes || event.request_bytes || 0)),
    responseBytes: Math.max(0, Number(event.responseBytes || event.response_bytes || 0)),
    operationType,
    ipHash: event.ipHash || event.ip_hash || hashIp(event.ip || event.clientIp || 'unknown'),
    userAgent: String(event.userAgent || event.user_agent || '').slice(0, 500),
    adminId: event.adminId || event.admin_id || null,
    userId: event.userId || event.user_id || null,
    errorMessage: event.errorMessage || event.error_message || null,
    timestamp,
  };
}

function toDbRow(event) {
  return {
    request_id: event.requestId,
    api_name: event.apiName,
    route_key: event.routeKey,
    route_group: event.routeGroup,
    method: event.method,
    endpoint: event.endpoint,
    status_code: event.statusCode,
    success: event.success,
    latency_ms: event.latencyMs,
    request_bytes: Math.round(event.requestBytes || 0),
    response_bytes: Math.round(event.responseBytes || 0),
    operation_type: event.operationType,
    ip_hash: event.ipHash,
    user_agent: event.userAgent,
    admin_id: event.adminId,
    user_id: event.userId,
    error_message: event.errorMessage,
    created_at: event.timestamp,
  };
}

function fromDbLog(row) {
  return normalizeCapturedEvent({
    request_id: row.request_id || row.id,
    api_name: row.api_name,
    route_key: row.route_key,
    route_group: row.route_group,
    method: row.method,
    endpoint: row.endpoint,
    status_code: row.status_code,
    success: row.success,
    latency_ms: row.latency_ms,
    request_bytes: row.request_bytes,
    response_bytes: row.response_bytes,
    operation_type: row.operation_type,
    ip_hash: row.ip_hash,
    user_agent: row.user_agent,
    admin_id: row.admin_id,
    user_id: row.user_id,
    error_message: row.error_message,
    created_at: row.created_at,
  });
}

function updateRouteStats(event) {
  const current = memoryRoutes.get(event.routeKey) || {
    apiName: event.apiName,
    routeKey: event.routeKey,
    routeGroup: event.routeGroup,
    method: event.method,
    endpoint: event.endpoint,
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    readCount: 0,
    writeCount: 0,
    latencySumMs: 0,
    latencyMinMs: null,
    latencyMaxMs: 0,
    recentLatencies: [],
    lastStatusCode: 0,
    lastCheckedAt: null,
  };

  current.totalRequests += 1;
  current.successCount += event.success ? 1 : 0;
  current.failureCount += event.success ? 0 : 1;
  current.readCount += event.operationType === 'read' ? 1 : 0;
  current.writeCount += event.operationType === 'write' ? 1 : 0;
  current.latencySumMs += event.latencyMs;
  current.latencyMinMs = current.latencyMinMs == null ? event.latencyMs : Math.min(current.latencyMinMs, event.latencyMs);
  current.latencyMaxMs = Math.max(current.latencyMaxMs, event.latencyMs);
  current.recentLatencies.push(event.latencyMs);
  if (current.recentLatencies.length > 250) current.recentLatencies.shift();
  current.lastStatusCode = event.statusCode;
  current.lastCheckedAt = event.timestamp;
  memoryRoutes.set(event.routeKey, current);
}

function addRecentLog(event) {
  recentLogs.unshift(event);
  if (recentLogs.length > RECENT_LOG_LIMIT) recentLogs.length = RECENT_LOG_LIMIT;
}

function pushLocalEvent(event) {
  if (localQueue.length >= LOCAL_QUEUE_LIMIT) {
    const overflow = localQueue.length - LOCAL_QUEUE_LIMIT + 1;
    localQueue.splice(0, overflow);
    serviceState.droppedEvents += overflow;
  }
  localQueue.push(event);
}

async function pushRedisEvent(event) {
  if (!upstashRedis) {
    pushLocalEvent(event);
    return;
  }

  try {
    const payload = JSON.stringify(event);
    const pipeline = upstashRedis.pipeline();
    pipeline.lpush(REDIS_EVENT_KEY, payload);
    pipeline.ltrim(REDIS_EVENT_KEY, 0, REDIS_EVENTS_LIMIT - 1);
    await pipeline.exec();
    serviceState.redisBufferedEvents += 1;
    serviceState.lastRedisWriteAt = new Date().toISOString();
  } catch (error) {
    markRedisError(error);
    serviceState.redisWriteFailures += 1;
    serviceState.lastRedisErrorAt = new Date().toISOString();
    serviceState.lastRedisError = sanitizeDbError(error);
    pushLocalEvent(event);
  }
}

export function recordApiRequest(event) {
  const normalized = normalizeCapturedEvent(event);
  updateRouteStats(normalized);
  addRecentLog(normalized);

  // Do not await Redis from the request path. Failures are captured and moved
  // to the bounded local queue so monitoring can degrade without breaking API traffic.
  pushRedisEvent(normalized).catch((error) => {
    serviceState.redisWriteFailures += 1;
    serviceState.lastRedisErrorAt = new Date().toISOString();
    serviceState.lastRedisError = sanitizeDbError(error);
    pushLocalEvent(normalized);
  });

  return normalized;
}

async function drainRedisEvents(maxEvents = REDIS_DRAIN_BATCH_SIZE) {
  if (!upstashRedis) return [];

  try {
    const drained = await upstashRedis.rpop(REDIS_EVENT_KEY, maxEvents);
    const values = Array.isArray(drained) ? drained : drained ? [drained] : [];
    return values.map(safeJsonParse).filter(Boolean).map(normalizeCapturedEvent);
  } catch (error) {
    markRedisError(error);
    serviceState.lastRedisErrorAt = new Date().toISOString();
    serviceState.lastRedisError = sanitizeDbError(error);
    return [];
  }
}

function drainLocalEvents(maxEvents = LOCAL_QUEUE_LIMIT) {
  if (localQueue.length === 0) return [];
  return localQueue.splice(0, maxEvents);
}

export async function flushApiRequestQueue({ maxRedisEvents = REDIS_DRAIN_BATCH_SIZE } = {}) {
  const events = [
    ...drainLocalEvents(),
    ...(await drainRedisEvents(maxRedisEvents)),
  ];

  if (events.length === 0) {
    return {
      success: true,
      inserted: 0,
      redisEventsDrained: 0,
      localQueueSize: localQueue.length,
      timestamp: new Date().toISOString(),
    };
  }

  if (!supabase) {
    for (const event of events) pushLocalEvent(event);
    return {
      success: false,
      inserted: 0,
      queued: events.length,
      reason: 'Supabase is not configured.',
      timestamp: new Date().toISOString(),
    };
  }

  const rows = events.map(toDbRow);

  try {
    const { error } = await supabase.from('api_request_logs').insert(rows);
    if (error) throw error;

    serviceState.lastFlushAt = new Date().toISOString();
    serviceState.lastFlushError = null;
    return {
      success: true,
      inserted: rows.length,
      localQueueSize: localQueue.length,
      timestamp: serviceState.lastFlushAt,
    };
  } catch (error) {
    serviceState.dbWriteFailures += 1;
    serviceState.lastFlushErrorAt = new Date().toISOString();
    serviceState.lastFlushError = sanitizeDbError(error);
    if (isSupabaseNetworkError(error)) markSupabaseUnavailable(error, 'api monitoring flush', { log: true });

    if (!isMissingMonitoringTable(error)) {
      for (const event of events) pushLocalEvent(event);
    }

    return {
      success: false,
      inserted: 0,
      requeued: isMissingMonitoringTable(error) ? 0 : events.length,
      error: serviceState.lastFlushError,
      missingTable: isMissingMonitoringTable(error),
      timestamp: new Date().toISOString(),
    };
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[clamp(index, 0, sorted.length - 1)] || 0;
}

function calculateHealth({ totalRequests, failureCount, avgLatencyMs, p95LatencyMs, lastCheckedAt }) {
  if (!lastCheckedAt || Date.now() - parseDate(lastCheckedAt).getTime() > OFFLINE_AFTER_MS) {
    return { status: 'offline', healthScore: 0, uptimePct: 0, errorRatePct: 100 };
  }

  const errorRatePct = totalRequests ? (failureCount / totalRequests) * 100 : 0;
  const uptimePct = totalRequests ? ((totalRequests - failureCount) / totalRequests) * 100 : 100;
  const latencyPenalty = clamp((avgLatencyMs - 250) / 20, 0, 35);
  const p95Penalty = clamp((p95LatencyMs - 750) / 35, 0, 25);
  const errorPenalty = clamp(errorRatePct * 1.4, 0, 50);
  const healthScore = clamp(100 - latencyPenalty - p95Penalty - errorPenalty, 0, 100);

  let status = 'healthy';
  if (errorRatePct >= 25 || avgLatencyMs >= 2000 || p95LatencyMs >= 3500 || healthScore < 50) status = 'critical';
  else if (errorRatePct >= 5 || avgLatencyMs >= 800 || p95LatencyMs >= 1500 || healthScore < 80) status = 'warning';

  return {
    status,
    healthScore: round(healthScore, 1),
    uptimePct: round(uptimePct, 2),
    errorRatePct: round(errorRatePct, 2),
  };
}

function rowFromAggregate(stats) {
  const totalRequests = Number(stats.totalRequests || stats.total_requests || 0);
  const failureCount = Number(stats.failureCount || stats.failure_count || 0);
  const latencySumMs = Number(stats.latencySumMs || stats.latency_sum_ms || 0);
  const avgLatencyMs = totalRequests ? Math.round(latencySumMs / totalRequests) : 0;
  const latencies = stats.recentLatencies || [];
  const p95LatencyMs = Number(stats.p95LatencyMs || stats.latency_p95_ms || percentile(latencies, 95) || avgLatencyMs);
  const lastCheckedAt = stats.lastCheckedAt || stats.last_checked_at || stats.bucket_start || null;
  const health = calculateHealth({ totalRequests, failureCount, avgLatencyMs, p95LatencyMs, lastCheckedAt });

  return {
    apiName: stats.apiName || stats.api_name || stats.routeKey || stats.route_key,
    routeKey: stats.routeKey || stats.route_key,
    routeGroup: stats.routeGroup || stats.route_group || groupFromPath(stats.endpoint || ''),
    method: stats.method,
    endpoint: stats.endpoint,
    status: stats.status || health.status,
    uptimePct: Number(stats.uptimePct || stats.uptime_pct || health.uptimePct),
    healthScore: Number(stats.healthScore || stats.health_score || health.healthScore),
    latencyMs: Number(stats.latencyMs || stats.latency_ms || stats.lastLatencyMs || avgLatencyMs),
    avgResponseTimeMs: avgLatencyMs,
    p50LatencyMs: Number(stats.p50LatencyMs || stats.latency_p50_ms || percentile(latencies, 50) || avgLatencyMs),
    p95LatencyMs,
    p99LatencyMs: Number(stats.p99LatencyMs || stats.latency_p99_ms || percentile(latencies, 99) || p95LatencyMs),
    maxLatencyMs: Number(stats.maxLatencyMs || stats.latency_max_ms || 0),
    totalRequests,
    reads: Number(stats.readCount || stats.read_count || 0),
    writes: Number(stats.writeCount || stats.write_count || 0),
    failedRequests: failureCount,
    successRequests: Number(stats.successCount || stats.success_count || Math.max(0, totalRequests - failureCount)),
    errorRatePct: Number(stats.errorRatePct || stats.error_rate_pct || health.errorRatePct),
    lastStatusCode: Number(stats.lastStatusCode || stats.last_status_code || 0),
    lastCheckedAt,
  };
}

function combineStatus(current, next) {
  return (STATUS_RANK[next] || 0) > (STATUS_RANK[current] || 0) ? next : current;
}

function buildOverviewFromEvents(events, range = '24h') {
  const byRoute = new Map();

  for (const event of events) {
    const route = byRoute.get(event.routeKey) || {
      apiName: event.apiName,
      routeKey: event.routeKey,
      routeGroup: event.routeGroup,
      method: event.method,
      endpoint: event.endpoint,
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      readCount: 0,
      writeCount: 0,
      latencySumMs: 0,
      latencyMaxMs: 0,
      recentLatencies: [],
      lastStatusCode: 0,
      lastCheckedAt: null,
    };

    route.totalRequests += 1;
    route.successCount += event.success ? 1 : 0;
    route.failureCount += event.success ? 0 : 1;
    route.readCount += event.operationType === 'read' ? 1 : 0;
    route.writeCount += event.operationType === 'write' ? 1 : 0;
    route.latencySumMs += event.latencyMs;
    route.latencyMaxMs = Math.max(route.latencyMaxMs, event.latencyMs);
    route.recentLatencies.push(event.latencyMs);
    route.lastStatusCode = event.statusCode;
    if (!route.lastCheckedAt || parseDate(event.timestamp) > parseDate(route.lastCheckedAt)) {
      route.lastCheckedAt = event.timestamp;
    }
    byRoute.set(event.routeKey, route);
  }

  const apis = Array.from(byRoute.values()).map(rowFromAggregate).sort((a, b) => {
    const statusDelta = (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0);
    if (statusDelta !== 0) return statusDelta;
    return b.totalRequests - a.totalRequests;
  });

  return buildOverviewPayload(apis, range, {
    source: events.length ? 'request_logs' : 'memory',
  });
}

function buildOverviewFromMemory(range = '24h') {
  const apis = Array.from(memoryRoutes.values()).map(rowFromAggregate).sort((a, b) => b.totalRequests - a.totalRequests);
  return buildOverviewPayload(apis, range, { source: 'memory' });
}

function buildOverviewPayload(apis, range, meta = {}) {
  const totals = apis.reduce((acc, api) => {
    acc.totalRequests += api.totalRequests;
    acc.failedRequests += api.failedRequests;
    acc.reads += api.reads;
    acc.writes += api.writes;
    acc.latencyWeightedSum += api.avgResponseTimeMs * api.totalRequests;
    acc.healthScoreSum += api.healthScore;
    acc.status = combineStatus(acc.status, api.status);
    return acc;
  }, {
    totalRequests: 0,
    failedRequests: 0,
    reads: 0,
    writes: 0,
    latencyWeightedSum: 0,
    healthScoreSum: 0,
    status: 'healthy',
  });

  const memory = process.memoryUsage();
  const loadAverage = os.loadavg();
  const cpu = process.cpuUsage();
  const avgResponseTimeMs = totals.totalRequests ? Math.round(totals.latencyWeightedSum / totals.totalRequests) : 0;
  const errorRatePct = totals.totalRequests ? round((totals.failedRequests / totals.totalRequests) * 100, 2) : 0;
  const uptimePct = totals.totalRequests ? round(((totals.totalRequests - totals.failedRequests) / totals.totalRequests) * 100, 2) : 100;

  return {
    success: true,
    range,
    source: meta.source || 'rollups',
    timestamp: new Date().toISOString(),
    summary: {
      status: totals.totalRequests ? totals.status : 'offline',
      healthScore: apis.length ? round(totals.healthScoreSum / apis.length, 1) : 0,
      uptimePct,
      avgResponseTimeMs,
      errorRatePct,
      totalRequests: totals.totalRequests,
      reads: totals.reads,
      writes: totals.writes,
      failedRequests: totals.failedRequests,
      apiCount: apis.length,
    },
    systemLoad: {
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
      cpu,
      loadAverage,
    },
    ingestion: getMonitoringIngestionState(),
    apis,
  };
}

async function cacheOverview(payload) {
  if (!upstashRedis || CACHE_TTL_SECONDS <= 0) return;
  try {
    await upstashRedis.set(REDIS_OVERVIEW_KEY, JSON.stringify(payload), { ex: CACHE_TTL_SECONDS });
  } catch (error) {
    markRedisError(error);
  }
}

async function readCachedOverview() {
  if (!upstashRedis || CACHE_TTL_SECONDS <= 0) return null;
  try {
    const cached = await upstashRedis.get(REDIS_OVERVIEW_KEY);
    return safeJsonParse(cached);
  } catch (error) {
    markRedisError(error);
    return null;
  }
}

export function getMonitoringIngestionState() {
  return {
    ...serviceState,
    localQueueSize: localQueue.length,
    recentLogSize: recentLogs.length,
    memoryRouteCount: memoryRoutes.size,
    redisConfigured: Boolean(upstashRedis),
    supabaseConfigured: Boolean(supabase),
  };
}

async function queryRecentLogs({ range = '24h', routeKey = null, limit = OVERVIEW_LOG_LIMIT, status = null } = {}) {
  if (!supabase) return { data: null, error: null };
  let query = supabase
    .from('api_request_logs')
    .select('*')
    .gte('created_at', rangeToStart(range).toISOString())
    .order('created_at', { ascending: false })
    .limit(limit);

  if (routeKey) query = query.eq('route_key', routeKey);
  if (status === 'failed') query = query.gte('status_code', 400);
  if (status === 'server_error') query = query.gte('status_code', 500);

  return query;
}

export async function getApiOverview({ range = '24h', forceFresh = false } = {}) {
  if (!forceFresh) {
    const cached = await readCachedOverview();
    if (cached?.success && cached.range === range) return cached;
  }

  await flushApiRequestQueue({ maxRedisEvents: Math.min(REDIS_DRAIN_BATCH_SIZE, 500) });

  if (supabase) {
    const { data, error } = await queryRecentLogs({ range, limit: OVERVIEW_LOG_LIMIT });
    if (!error && Array.isArray(data)) {
      const payload = buildOverviewFromEvents(data.map(fromDbLog), range);
      await cacheOverview(payload);
      return payload;
    }
    if (error && !isMissingMonitoringTable(error)) {
      console.warn('[api-monitor] overview query failed:', error.message || error);
    }
  }

  const fallback = buildOverviewFromMemory(range);
  await cacheOverview(fallback);
  return fallback;
}

function bucketStart(date, minutes) {
  const ms = minutes * 60 * 1000;
  return new Date(Math.floor(parseDate(date).getTime() / ms) * ms);
}

function aggregateRows(events, bucketMinutes) {
  const rows = new Map();

  for (const event of events) {
    const bucket = bucketStart(event.timestamp, bucketMinutes).toISOString();
    const key = `${bucket}|${event.routeKey}|${event.method}`;
    const row = rows.get(key) || {
      bucket_start: bucket,
      bucket_minutes: bucketMinutes,
      route_key: event.routeKey,
      api_name: event.apiName,
      route_group: event.routeGroup,
      method: event.method,
      endpoint: event.endpoint,
      total_requests: 0,
      success_count: 0,
      failure_count: 0,
      read_count: 0,
      write_count: 0,
      latency_sum_ms: 0,
      latency_min_ms: null,
      latency_max_ms: 0,
      latency_p50_ms: 0,
      latency_p95_ms: 0,
      latency_p99_ms: 0,
      request_bytes: 0,
      response_bytes: 0,
      uptime_checks: 0,
      uptime_ok: 0,
      health_score: 0,
      status: 'healthy',
      last_status_code: 0,
      last_checked_at: event.timestamp,
      latencies: [],
    };

    row.total_requests += 1;
    row.success_count += event.success ? 1 : 0;
    row.failure_count += event.success ? 0 : 1;
    row.read_count += event.operationType === 'read' ? 1 : 0;
    row.write_count += event.operationType === 'write' ? 1 : 0;
    row.latency_sum_ms += event.latencyMs;
    row.latency_min_ms = row.latency_min_ms == null ? event.latencyMs : Math.min(row.latency_min_ms, event.latencyMs);
    row.latency_max_ms = Math.max(row.latency_max_ms, event.latencyMs);
    row.request_bytes += event.requestBytes;
    row.response_bytes += event.responseBytes;
    row.uptime_checks += 1;
    row.uptime_ok += event.success ? 1 : 0;
    row.last_status_code = event.statusCode;
    if (parseDate(event.timestamp) >= parseDate(row.last_checked_at)) row.last_checked_at = event.timestamp;
    row.latencies.push(event.latencyMs);
    rows.set(key, row);
  }

  return Array.from(rows.values()).map((row) => {
    const avg = row.total_requests ? row.latency_sum_ms / row.total_requests : 0;
    const health = calculateHealth({
      totalRequests: row.total_requests,
      failureCount: row.failure_count,
      avgLatencyMs: avg,
      p95LatencyMs: percentile(row.latencies, 95),
      lastCheckedAt: row.last_checked_at,
    });
    const { latencies, ...clean } = row;
    return {
      ...clean,
      latency_p50_ms: percentile(latencies, 50),
      latency_p95_ms: percentile(latencies, 95),
      latency_p99_ms: percentile(latencies, 99),
      health_score: health.healthScore,
      status: health.status,
      updated_at: new Date().toISOString(),
    };
  });
}

export async function aggregateApiMetrics({ rangeMinutes = 10, bucketMinutes = 1 } = {}) {
  const flush = await flushApiRequestQueue({ maxRedisEvents: REDIS_DRAIN_BATCH_SIZE });

  if (!supabase) {
    return {
      success: false,
      flush,
      upserted: 0,
      reason: 'Supabase is not configured.',
      timestamp: new Date().toISOString(),
    };
  }

  const start = new Date(Date.now() - rangeMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('api_request_logs')
    .select('*')
    .gte('created_at', start)
    .order('created_at', { ascending: true })
    .limit(Math.max(1000, OVERVIEW_LOG_LIMIT));

  if (error) {
    serviceState.lastAggregationErrorAt = new Date().toISOString();
    serviceState.lastAggregationError = sanitizeDbError(error);
    if (isSupabaseNetworkError(error)) markSupabaseUnavailable(error, 'api monitoring aggregation', { log: true });
    return {
      success: false,
      flush,
      upserted: 0,
      error: serviceState.lastAggregationError,
      missingTable: isMissingMonitoringTable(error),
      timestamp: new Date().toISOString(),
    };
  }

  const rows = aggregateRows((data || []).map(fromDbLog), bucketMinutes);
  if (rows.length === 0) {
    serviceState.lastAggregationAt = new Date().toISOString();
    return { success: true, flush, upserted: 0, timestamp: serviceState.lastAggregationAt };
  }

  const { error: upsertError } = await supabase
    .from('api_metric_rollups')
    .upsert(rows, { onConflict: 'bucket_start,bucket_minutes,route_key,method' });

  if (upsertError) {
    serviceState.lastAggregationErrorAt = new Date().toISOString();
    serviceState.lastAggregationError = sanitizeDbError(upsertError);
    return {
      success: false,
      flush,
      upserted: 0,
      error: serviceState.lastAggregationError,
      missingTable: isMissingMonitoringTable(upsertError),
      timestamp: new Date().toISOString(),
    };
  }

  serviceState.lastAggregationAt = new Date().toISOString();
  serviceState.lastAggregationError = null;

  return {
    success: true,
    flush,
    upserted: rows.length,
    timestamp: serviceState.lastAggregationAt,
  };
}

function buildSeriesFromEvents(events) {
  const buckets = new Map();
  for (const event of events) {
    const bucket = bucketStart(event.timestamp, 5).toISOString();
    const row = buckets.get(bucket) || {
      timestamp: bucket,
      requests: 0,
      reads: 0,
      writes: 0,
      failures: 0,
      latencySumMs: 0,
      latencies: [],
    };
    row.requests += 1;
    row.reads += event.operationType === 'read' ? 1 : 0;
    row.writes += event.operationType === 'write' ? 1 : 0;
    row.failures += event.success ? 0 : 1;
    row.latencySumMs += event.latencyMs;
    row.latencies.push(event.latencyMs);
    buckets.set(bucket, row);
  }

  return Array.from(buckets.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map((row) => ({
    timestamp: row.timestamp,
    requests: row.requests,
    reads: row.reads,
    writes: row.writes,
    failures: row.failures,
    avgLatencyMs: row.requests ? Math.round(row.latencySumMs / row.requests) : 0,
    p95LatencyMs: percentile(row.latencies, 95),
    successRatePct: row.requests ? round(((row.requests - row.failures) / row.requests) * 100, 2) : 100,
  }));
}

function buildDistribution(events) {
  const buckets = [
    { label: '0-100ms', min: 0, max: 100, count: 0 },
    { label: '101-250ms', min: 101, max: 250, count: 0 },
    { label: '251-500ms', min: 251, max: 500, count: 0 },
    { label: '501-1000ms', min: 501, max: 1000, count: 0 },
    { label: '1001-2000ms', min: 1001, max: 2000, count: 0 },
    { label: '>2000ms', min: 2001, max: Infinity, count: 0 },
  ];

  for (const event of events) {
    const bucket = buckets.find((item) => event.latencyMs >= item.min && event.latencyMs <= item.max);
    if (bucket) bucket.count += 1;
  }

  return buckets.map(({ label, count }) => ({ label, count }));
}

function buildActivityHeatmap(events) {
  const heat = new Map();
  for (const event of events) {
    const date = parseDate(event.timestamp);
    const key = `${date.getDay()}-${date.getHours()}`;
    const row = heat.get(key) || {
      day: date.toLocaleDateString('en-US', { weekday: 'short' }),
      dayIndex: date.getDay(),
      hour: date.getHours(),
      requests: 0,
      failures: 0,
    };
    row.requests += 1;
    row.failures += event.success ? 0 : 1;
    heat.set(key, row);
  }
  return Array.from(heat.values()).sort((a, b) => a.dayIndex - b.dayIndex || a.hour - b.hour);
}

async function queryIncidents(routeKey = null) {
  if (!supabase) return [];
  let query = supabase
    .from('api_incidents')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(50);
  if (routeKey) query = query.eq('route_key', routeKey);
  const { data, error } = await query;
  if (error) return [];
  return data || [];
}

export async function getApiDetail(routeKey, { range = '24h', page = 1, pageSize = 25 } = {}) {
  const decodedRouteKey = decodeURIComponent(String(routeKey || ''));
  await flushApiRequestQueue({ maxRedisEvents: Math.min(REDIS_DRAIN_BATCH_SIZE, 500) });

  let events = [];
  let totalLogs = 0;
  let logs = [];
  let incidents = [];

  if (supabase) {
    const [eventQuery, logQuery, incidentRows] = await Promise.all([
      queryRecentLogs({ routeKey: decodedRouteKey, range, limit: DETAIL_LOG_LIMIT }),
      getRequestLogs({ routeKey: decodedRouteKey, page, pageSize }),
      queryIncidents(decodedRouteKey),
    ]);

    if (!eventQuery.error) events = (eventQuery.data || []).map(fromDbLog);
    if (!logQuery.error) {
      logs = logQuery.logs;
      totalLogs = logQuery.total;
    }
    incidents = incidentRows;
  } else {
    events = recentLogs.filter((event) => event.routeKey === decodedRouteKey);
    logs = events.slice((page - 1) * pageSize, page * pageSize);
    totalLogs = events.length;
  }

  if (events.length === 0) {
    events = recentLogs.filter((event) => event.routeKey === decodedRouteKey);
  }

  const overview = buildOverviewFromEvents(events, range);
  const api = overview.apis[0] || null;
  const failures = events.filter((event) => !event.success).slice(0, 20);
  const slowest = [...events].sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 10);

  return {
    success: true,
    range,
    timestamp: new Date().toISOString(),
    api,
    series: buildSeriesFromEvents(events),
    responseDistribution: buildDistribution(events),
    activityHeatmap: buildActivityHeatmap(events),
    recentFailures: failures,
    slowestEndpoints: slowest,
    requestLogs: {
      logs,
      page,
      pageSize,
      total: totalLogs,
      totalPages: Math.max(1, Math.ceil(totalLogs / pageSize)),
    },
    incidents,
  };
}

export async function getRequestLogs({ routeKey = null, page = 1, pageSize = 25, status = null } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = clamp(Number(pageSize) || 25, 1, 100);
  const from = (safePage - 1) * safePageSize;
  const to = from + safePageSize - 1;

  if (!supabase) {
    const filtered = recentLogs.filter((event) => {
      if (routeKey && event.routeKey !== routeKey) return false;
      if (status === 'failed' && event.statusCode < 400) return false;
      return true;
    });
    return {
      success: true,
      logs: filtered.slice(from, to + 1),
      total: filtered.length,
      page: safePage,
      pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(filtered.length / safePageSize)),
    };
  }

  let query = supabase
    .from('api_request_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (routeKey) query = query.eq('route_key', routeKey);
  if (status === 'failed') query = query.gte('status_code', 400);
  if (status === 'server_error') query = query.gte('status_code', 500);

  const { data, error, count } = await query;
  if (error) {
    return {
      success: false,
      error: sanitizeDbError(error),
      logs: [],
      total: 0,
      page: safePage,
      pageSize: safePageSize,
      totalPages: 1,
    };
  }

  return {
    success: true,
    logs: (data || []).map(fromDbLog),
    total: count || 0,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil((count || 0) / safePageSize)),
  };
}

function healthCheckPaths() {
  const configured = String(process.env.API_MONITOR_HEALTH_CHECK_PATHS || '/api/health/services,/api/config/public')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return configured.length ? configured : ['/api/health/services'];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = HEALTH_CHECK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const started = process.hrtime.bigint();
    const response = await fetch(url, { ...options, signal: controller.signal });
    const latencyMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    return { response, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

export async function runScheduledHealthChecks() {
  const baseUrl = getPublicBackendUrl();
  if (!baseUrl) {
    return {
      success: false,
      checked: 0,
      reason: 'RENDER_BACKEND_URL is required for public health checks.',
      timestamp: new Date().toISOString(),
    };
  }

  const results = [];
  for (const path of healthCheckPaths()) {
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const startedAt = new Date().toISOString();
    try {
      const { response, latencyMs } = await fetchWithTimeout(url, {
        method: 'GET',
        headers: { 'User-Agent': 'xstream-api-monitor/1.0' },
      });
      const event = recordApiRequest({
        requestId: `health-${crypto.randomUUID()}`,
        apiName: `GET ${normalizeApiPath(path)}`,
        routeKey: buildRouteKey('GET', path),
        method: 'GET',
        endpoint: path,
        statusCode: response.status,
        latencyMs,
        requestBytes: 0,
        responseBytes: Number(response.headers.get('content-length') || 0),
        operationType: 'read',
        ip: 'qstash-health-check',
        userAgent: 'xstream-api-monitor/1.0',
        timestamp: startedAt,
        errorMessage: response.ok ? null : `Health check returned HTTP ${response.status}`,
      });
      results.push({ path, statusCode: response.status, ok: response.ok, latencyMs, routeKey: event.routeKey });
    } catch (error) {
      const latencyMs = HEALTH_CHECK_TIMEOUT_MS;
      const event = recordApiRequest({
        requestId: `health-${crypto.randomUUID()}`,
        apiName: `GET ${normalizeApiPath(path)}`,
        routeKey: buildRouteKey('GET', path),
        method: 'GET',
        endpoint: path,
        statusCode: 599,
        latencyMs,
        operationType: 'read',
        ip: 'qstash-health-check',
        userAgent: 'xstream-api-monitor/1.0',
        timestamp: startedAt,
        errorMessage: String(error?.message || error).slice(0, 500),
      });
      results.push({ path, statusCode: 599, ok: false, latencyMs, routeKey: event.routeKey, error: event.errorMessage });
    }
  }

  const flush = await flushApiRequestQueue({ maxRedisEvents: REDIS_DRAIN_BATCH_SIZE });
  return {
    success: true,
    checked: results.length,
    results,
    flush,
    timestamp: new Date().toISOString(),
  };
}

async function dispatchIncidentAlert(incident) {
  const alertUrl = String(process.env.API_MONITOR_ALERT_WEBHOOK_URL || '').trim();
  if (!alertUrl || !qstashClient) return null;

  try {
    return await qstashClient.publishJSON({
      url: alertUrl,
      body: {
        type: 'api.incident',
        incident,
        service: 'xstream-backend',
        timestamp: new Date().toISOString(),
      },
      retries: readPositiveInteger('API_MONITOR_ALERT_RETRIES', 3),
      retryDelay: process.env.API_MONITOR_ALERT_RETRY_DELAY || '1000 * pow(2, retried)',
      failureCallback: getMonitoringWorkflowUrl('/failure'),
      headers: {
        'Content-Type': 'application/json',
        'X-Alert-Source': 'xstream-api-monitor',
      },
    });
  } catch (error) {
    console.warn('[api-monitor] failed to dispatch alert through QStash:', error?.message || error);
    return null;
  }
}

export async function detectApiIncidents({ range = '1h' } = {}) {
  const overview = await getApiOverview({ range, forceFresh: true });
  const candidates = overview.apis.filter((api) => ['warning', 'critical', 'offline'].includes(api.status));

  if (!supabase) {
    serviceState.lastIncidentScanAt = new Date().toISOString();
    return {
      success: true,
      created: 0,
      resolved: 0,
      candidates: candidates.length,
      timestamp: serviceState.lastIncidentScanAt,
      storage: 'memory-only',
    };
  }

  const { data: activeRows, error } = await supabase
    .from('api_incidents')
    .select('*')
    .is('resolved_at', null);

  if (error) {
    return {
      success: false,
      created: 0,
      resolved: 0,
      error: sanitizeDbError(error),
      missingTable: isMissingMonitoringTable(error),
      timestamp: new Date().toISOString(),
    };
  }

  const activeByRoute = new Map((activeRows || []).map((row) => [row.route_key, row]));
  const candidateKeys = new Set(candidates.map((api) => api.routeKey));
  let created = 0;
  let updated = 0;
  let resolved = 0;

  for (const api of candidates) {
    const existing = activeByRoute.get(api.routeKey);
    const reason = `${api.status}: ${api.errorRatePct}% errors, ${api.avgResponseTimeMs}ms avg, ${api.p95LatencyMs}ms p95`;
    if (existing) {
      const { error: updateError } = await supabase
        .from('api_incidents')
        .update({
          status: api.status,
          severity: api.status === 'offline' ? 'critical' : api.status,
          reason,
          last_seen_at: new Date().toISOString(),
          sample: api,
        })
        .eq('id', existing.id);
      if (!updateError) updated += 1;
    } else {
      const payload = {
        route_key: api.routeKey,
        api_name: api.apiName,
        status: api.status,
        severity: api.status === 'offline' ? 'critical' : api.status,
        reason,
        started_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        sample: api,
      };
      const { data: inserted, error: insertError } = await supabase
        .from('api_incidents')
        .insert(payload)
        .select('*')
        .single();
      if (!insertError) {
        created += 1;
        await dispatchIncidentAlert(inserted || payload);
      }
    }
  }

  for (const row of activeRows || []) {
    if (candidateKeys.has(row.route_key)) continue;
    const { error: resolveError } = await supabase
      .from('api_incidents')
      .update({ resolved_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), status: 'resolved' })
      .eq('id', row.id);
    if (!resolveError) resolved += 1;
  }

  serviceState.lastIncidentScanAt = new Date().toISOString();
  return {
    success: true,
    created,
    updated,
    resolved,
    candidates: candidates.length,
    timestamp: serviceState.lastIncidentScanAt,
  };
}

function peakHourFromEvents(events) {
  const counts = new Map();
  for (const event of events) {
    const hour = parseDate(event.timestamp).getHours();
    counts.set(hour, (counts.get(hour) || 0) + 1);
  }
  let peakHour = 0;
  let peakCount = 0;
  for (const [hour, count] of counts.entries()) {
    if (count > peakCount) {
      peakHour = hour;
      peakCount = count;
    }
  }
  return peakHour;
}

export async function generateApiSummary({ period = 'daily' } = {}) {
  await flushApiRequestQueue({ maxRedisEvents: REDIS_DRAIN_BATCH_SIZE });
  if (!supabase) {
    return {
      success: false,
      period,
      rows: 0,
      reason: 'Supabase is not configured.',
      timestamp: new Date().toISOString(),
    };
  }

  const now = new Date();
  const start = new Date(now);
  if (period === 'weekly') start.setDate(now.getDate() - 7);
  else start.setDate(now.getDate() - 1);

  const { data, error } = await supabase
    .from('api_request_logs')
    .select('*')
    .gte('created_at', start.toISOString())
    .order('created_at', { ascending: true })
    .limit(50000);

  if (error) {
    return {
      success: false,
      period,
      rows: 0,
      error: sanitizeDbError(error),
      missingTable: isMissingMonitoringTable(error),
      timestamp: new Date().toISOString(),
    };
  }

  const events = (data || []).map(fromDbLog);
  const overview = buildOverviewFromEvents(events, period === 'weekly' ? '7d' : '24h');
  const summaryDate = new Date().toISOString().slice(0, 10);
  const rows = overview.apis.map((api) => {
    const routeEvents = events.filter((event) => event.routeKey === api.routeKey);
    return {
      summary_date: summaryDate,
      period,
      route_key: api.routeKey,
      api_name: api.apiName,
      total_requests: api.totalRequests,
      failure_count: api.failedRequests,
      avg_latency_ms: api.avgResponseTimeMs,
      p95_latency_ms: api.p95LatencyMs,
      uptime_pct: api.uptimePct,
      peak_hour: peakHourFromEvents(routeEvents),
      health_score: api.healthScore,
      created_at: new Date().toISOString(),
    };
  });

  if (rows.length === 0) {
    serviceState.lastSummaryAt = new Date().toISOString();
    return { success: true, period, rows: 0, timestamp: serviceState.lastSummaryAt };
  }

  const { error: upsertError } = await supabase
    .from('api_analytics_summaries')
    .upsert(rows, { onConflict: 'summary_date,period,route_key' });

  if (upsertError) {
    return {
      success: false,
      period,
      rows: 0,
      error: sanitizeDbError(upsertError),
      missingTable: isMissingMonitoringTable(upsertError),
      timestamp: new Date().toISOString(),
    };
  }

  serviceState.lastSummaryAt = new Date().toISOString();
  return {
    success: true,
    period,
    rows: rows.length,
    timestamp: serviceState.lastSummaryAt,
  };
}

export async function runMonitoringAggregationCycle() {
  const [aggregation, healthChecks] = await Promise.all([
    aggregateApiMetrics({ rangeMinutes: readPositiveInteger('API_MONITOR_AGGREGATION_RANGE_MINUTES', 10), bucketMinutes: 1 }),
    runScheduledHealthChecks(),
  ]);
  const incidents = await detectApiIncidents({ range: '1h' });
  return {
    success: aggregation.success && healthChecks.success && incidents.success,
    aggregation,
    healthChecks,
    incidents,
    timestamp: new Date().toISOString(),
  };
}
