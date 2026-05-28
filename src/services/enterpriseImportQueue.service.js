import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { markRedisError, pingRedis, runRedisOperation, upstashRedis } from '../config/redis.js';
import {
  getEnterpriseImportWorkflowUrl,
  getQstashStatus,
  qstashClient,
} from '../config/qstash.js';
import { supabase } from '../config/supabase.js';
import { appMemoryCache } from './localMemoryCache.service.js';

export const ENTERPRISE_IMPORT_QUEUE_NAME = 'enterprise-import';

const PREFIX = String(process.env.IMPORT_QUEUE_REDIS_PREFIX || 'xstream:enterprise-import').replace(/:+$/, '');
const READY_KEY = `${PREFIX}:ready`;
const DELAYED_KEY = `${PREFIX}:delayed`;
const ACTIVE_KEY = `${PREFIX}:active`;
const DEAD_KEY = `${PREFIX}:dead-letter`;
const EVENTS_KEY = `${PREFIX}:events`;
const WORKERS_KEY = `${PREFIX}:workers`;
const WAKE_KEY = `${PREFIX}:wake`;

const DEFAULT_WORKER_ID = `${process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || 'local'}:${process.pid}`;
const QUEUE_JOB_TTL_SECONDS = readPositiveInteger('IMPORT_QUEUE_JOB_TTL_SECONDS', 7 * 24 * 60 * 60);
const QUEUE_EVENT_MAXLEN = readPositiveInteger('IMPORT_QUEUE_EVENT_MAXLEN', 10000);
const DEAD_LETTER_MAXLEN = readPositiveInteger('IMPORT_QUEUE_DEAD_LETTER_MAXLEN', 1000);
const RECOVERY_SCAN_LIMIT = readPositiveInteger('IMPORT_QUEUE_RECOVERY_SCAN_LIMIT', 50);
const STALLED_JOB_MS = readPositiveInteger('IMPORT_STALE_JOB_MS', 30 * 60 * 1000);
const QSTASH_WAKE_ENABLED = readBoolean('IMPORT_QSTASH_WAKE_ENABLED', true);
const QSTASH_WAKE_TIMEOUT_SECONDS = readPositiveInteger('IMPORT_QSTASH_WAKE_TIMEOUT_SECONDS', 10);
const QSTASH_WAKE_RETRIES = readPositiveInteger('IMPORT_QSTASH_WAKE_RETRIES', 3);
const QUEUE_HEALTH_CACHE_MS = readPositiveInteger('IMPORT_QUEUE_HEALTH_CACHE_MS', 15_000);

const localQueueEvents = [];
let wakeResolvers = [];
let lastWakeAt = null;
let lastQstashWakeAt = null;
let lastQstashWakeError = null;

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function nowIso() {
  return new Date().toISOString();
}

function jobKey(jobId) {
  return `${PREFIX}:job:${jobId}`;
}

function lockKey(jobId) {
  return `${PREFIX}:lock:${jobId}`;
}

function workerKey(workerId) {
  return `${PREFIX}:worker:${workerId}`;
}

function safeJson(value, fallback = '{}') {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function summarizeError(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 500);
}

function redisRequired() {
  if (!upstashRedis) {
    const err = new Error('Upstash Redis is required for the enterprise import queue.');
    err.code = 'IMPORT_REDIS_NOT_CONFIGURED';
    throw err;
  }
  return upstashRedis;
}

function rememberLocalQueueEvent(event) {
  localQueueEvents.unshift(event);
  if (localQueueEvents.length > 200) localQueueEvents.length = 200;
}

export async function recordEnterpriseQueueEvent(type, payload = {}) {
  const event = {
    id: randomUUID(),
    queue: ENTERPRISE_IMPORT_QUEUE_NAME,
    type,
    timestamp: nowIso(),
    ...payload,
  };
  rememberLocalQueueEvent(event);

  if (!upstashRedis) return event;

  try {
    await upstashRedis.xadd(
      EVENTS_KEY,
      '*',
      { event: safeJson(event) },
      {
        trim: {
          type: 'MAXLEN',
          comparison: '~',
          threshold: QUEUE_EVENT_MAXLEN,
        },
      },
    );
  } catch (error) {
    markRedisError(error);
    console.warn('[enterprise-import:queue] event write failed:', summarizeError(error));
  }

  return event;
}

export async function assertEnterpriseImportQueueReady() {
  const redis = await pingRedis();
  if (!redis.configured || !redis.connected) {
    const err = new Error(redis.lastError || redis.message || 'Upstash Redis is not connected.');
    err.code = redis.configured ? 'IMPORT_REDIS_UNAVAILABLE' : 'IMPORT_REDIS_NOT_CONFIGURED';
    err.redis = redis;
    throw err;
  }
  return redis;
}

export async function enqueueEnterpriseImportJob(jobId, {
  delaySeconds = 0,
  reason = 'enqueue',
  source = 'backend',
  metadata = {},
  wake = true,
} = {}) {
  const redis = redisRequired();
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId) throw new Error('jobId is required to enqueue an enterprise import job.');

  const jobState = {
    jobId: cleanJobId,
    queue: ENTERPRISE_IMPORT_QUEUE_NAME,
    status: delaySeconds > 0 ? 'delayed' : 'queued',
    source,
    reason,
    metadata,
    enqueuedAt: nowIso(),
    delaySeconds: Math.max(0, Number(delaySeconds || 0)),
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(jobKey(cleanJobId), safeJson(jobState), { ex: QUEUE_JOB_TTL_SECONDS });
    if (jobState.delaySeconds > 0) {
      pipeline.zadd(DELAYED_KEY, { score: Date.now() + jobState.delaySeconds * 1000, member: cleanJobId });
    } else {
      pipeline.rpush(READY_KEY, cleanJobId);
    }
    await pipeline.exec();

    await recordEnterpriseQueueEvent(jobState.status, { jobId: cleanJobId, reason, source, delaySeconds: jobState.delaySeconds });
    if (wake) await dispatchEnterpriseImportWake({ reason, jobId: cleanJobId }).catch(() => null);
    return { queued: true, jobId: cleanJobId, delayed: jobState.delaySeconds > 0 };
  } catch (error) {
    markRedisError(error);
    await recordEnterpriseQueueEvent('enqueue_failed', { jobId: cleanJobId, reason, source, error: summarizeError(error) }).catch(() => null);
    throw error;
  }
}

async function popDelayedJobs() {
  if (!upstashRedis) return 0;
  const now = Date.now();
  let moved = 0;

  try {
    const due = await upstashRedis.zrange(DELAYED_KEY, 0, now, {
      byScore: true,
      offset: 0,
      count: RECOVERY_SCAN_LIMIT,
    });
    const ids = Array.isArray(due) ? due.map(String).filter(Boolean) : [];
    if (!ids.length) return 0;

    const pipeline = upstashRedis.pipeline();
    for (const id of ids) {
      pipeline.zrem(DELAYED_KEY, id);
      pipeline.rpush(READY_KEY, id);
    }
    await pipeline.exec();
    moved = ids.length;
    await recordEnterpriseQueueEvent('delayed_released', { count: moved });
  } catch (error) {
    markRedisError(error);
    console.warn('[enterprise-import:queue] delayed release failed:', summarizeError(error));
  }

  return moved;
}

export async function dequeueEnterpriseImportJob() {
  const redis = redisRequired();
  await popDelayedJobs();

  try {
    const value = await redis.lpop(READY_KEY);
    const jobId = Array.isArray(value) ? value[0] : value;
    if (!jobId) return null;

    const cleanJobId = String(jobId);
    await redis.set(jobKey(cleanJobId), safeJson({
      jobId: cleanJobId,
      queue: ENTERPRISE_IMPORT_QUEUE_NAME,
      status: 'dequeued',
      dequeuedAt: nowIso(),
    }), { ex: QUEUE_JOB_TTL_SECONDS }).catch(() => null);
    return cleanJobId;
  } catch (error) {
    markRedisError(error);
    throw error;
  }
}

export async function acquireEnterpriseImportLock(jobId, {
  workerId = DEFAULT_WORKER_ID,
  ttlSeconds = readPositiveInteger('IMPORT_WORKER_LOCK_TTL_SECONDS', 15 * 60),
} = {}) {
  const redis = redisRequired();
  const token = `${workerId}:${Date.now()}:${randomUUID()}`;
  const key = lockKey(jobId);
  const result = await redis.set(key, token, { nx: true, ex: ttlSeconds });
  const acquired = result === 'OK' || result === true;
  if (!acquired) {
    await recordEnterpriseQueueEvent('lock_skipped', { jobId, workerId });
    return { acquired: false, key, token, workerId, ttlSeconds };
  }

  const timestamp = Date.now();
  await redis.zadd(ACTIVE_KEY, { score: timestamp, member: String(jobId) }).catch(() => null);
  await recordEnterpriseQueueEvent('lock_acquired', { jobId, workerId, ttlSeconds });
  return { acquired: true, key, token, workerId, ttlSeconds };
}

export async function renewEnterpriseImportLock(lock) {
  if (!lock?.key || !lock?.token || !upstashRedis) return false;
  try {
    const current = await upstashRedis.get(lock.key);
    if (current !== lock.token) return false;
    await upstashRedis.expire(lock.key, lock.ttlSeconds || 900);
    await upstashRedis.zadd(ACTIVE_KEY, { score: Date.now(), member: String(lock.key).split(':').pop() || lock.key }).catch(() => null);
    return true;
  } catch (error) {
    markRedisError(error);
    return false;
  }
}

export async function releaseEnterpriseImportLock(lock) {
  if (!lock?.key || !lock?.token || !upstashRedis) return;
  try {
    const current = await upstashRedis.get(lock.key);
    if (current === lock.token) await upstashRedis.del(lock.key);
    const jobId = String(lock.key).split(':').pop();
    if (jobId) await upstashRedis.zrem(ACTIVE_KEY, jobId).catch(() => null);
    await recordEnterpriseQueueEvent('lock_released', { jobId, workerId: lock.workerId });
  } catch (error) {
    markRedisError(error);
  }
}

export async function markEnterpriseImportJobActive(jobId, workerId = DEFAULT_WORKER_ID) {
  if (!upstashRedis) return;
  await upstashRedis.set(jobKey(jobId), safeJson({
    jobId,
    queue: ENTERPRISE_IMPORT_QUEUE_NAME,
    status: 'active',
    workerId,
    startedAt: nowIso(),
  }), { ex: QUEUE_JOB_TTL_SECONDS }).catch((error) => markRedisError(error));
  await recordEnterpriseQueueEvent('active', { jobId, workerId });
}

export async function markEnterpriseImportJobCompleted(jobId, workerId = DEFAULT_WORKER_ID) {
  if (!upstashRedis) return;
  await upstashRedis.set(jobKey(jobId), safeJson({
    jobId,
    queue: ENTERPRISE_IMPORT_QUEUE_NAME,
    status: 'completed',
    workerId,
    completedAt: nowIso(),
  }), { ex: QUEUE_JOB_TTL_SECONDS }).catch((error) => markRedisError(error));
  await upstashRedis.zrem(ACTIVE_KEY, String(jobId)).catch(() => null);
  await recordEnterpriseQueueEvent('completed', { jobId, workerId });
}

export async function markEnterpriseImportJobFailed(jobId, {
  workerId = DEFAULT_WORKER_ID,
  error = null,
  final = false,
  attempt = 0,
} = {}) {
  if (!upstashRedis) return;
  const payload = {
    jobId,
    queue: ENTERPRISE_IMPORT_QUEUE_NAME,
    status: final ? 'dead-lettered' : 'failed',
    workerId,
    attempt,
    error: summarizeError(error),
    failedAt: nowIso(),
  };

  try {
    const pipeline = upstashRedis.pipeline();
    pipeline.set(jobKey(jobId), safeJson(payload), { ex: QUEUE_JOB_TTL_SECONDS });
    pipeline.zrem(ACTIVE_KEY, String(jobId));
    if (final) {
      pipeline.lpush(DEAD_KEY, safeJson(payload));
      pipeline.ltrim(DEAD_KEY, 0, DEAD_LETTER_MAXLEN - 1);
    }
    await pipeline.exec();
  } catch (redisError) {
    markRedisError(redisError);
  }

  await recordEnterpriseQueueEvent(final ? 'dead_lettered' : 'failed', payload);
}

export async function registerEnterpriseImportWorkerHeartbeat({
  workerId = DEFAULT_WORKER_ID,
  status = 'idle',
  currentJobId = null,
  concurrency = 1,
  startedAt = null,
  ttlSeconds = 45,
} = {}) {
  if (!upstashRedis) return null;
  const payload = {
    workerId,
    queue: ENTERPRISE_IMPORT_QUEUE_NAME,
    status,
    currentJobId,
    concurrency,
    pid: process.pid,
    host: process.env.HOSTNAME || null,
    startedAt,
    heartbeatAt: nowIso(),
  };
  try {
    const pipeline = upstashRedis.pipeline();
    pipeline.set(workerKey(workerId), safeJson(payload), { ex: ttlSeconds });
    pipeline.sadd(WORKERS_KEY, workerId);
    await pipeline.exec();
  } catch (error) {
    markRedisError(error);
  }
  return payload;
}

export function wakeEnterpriseImportWorkers(reason = 'manual') {
  lastWakeAt = nowIso();
  const resolvers = wakeResolvers;
  wakeResolvers = [];
  for (const resolve of resolvers) resolve({ reason, at: lastWakeAt });
}

export async function waitForEnterpriseImportWake(timeoutMs, signal = null) {
  if (signal?.aborted) return { reason: 'aborted' };
  return Promise.race([
    new Promise((resolve) => {
      const resolver = resolve;
      wakeResolvers.push(resolver);
      if (signal) {
        signal.addEventListener('abort', () => {
          wakeResolvers = wakeResolvers.filter((item) => item !== resolver);
          resolve({ reason: 'aborted' });
        }, { once: true });
      }
    }),
    sleep(timeoutMs).then(() => ({ reason: 'timeout' })),
  ]);
}

export async function dispatchEnterpriseImportWake({ reason = 'enqueue', jobId = null } = {}) {
  wakeEnterpriseImportWorkers(reason);
  if (!QSTASH_WAKE_ENABLED || !qstashClient) return { dispatched: false, reason: 'qstash_disabled' };

  const url = getEnterpriseImportWorkflowUrl('/wake');
  if (!url || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url)) {
    return { dispatched: false, reason: 'public_import_workflow_url_unavailable' };
  }

  try {
    const result = await qstashClient.publishJSON({
      url,
      body: {
        type: 'enterprise_import.wake',
        queue: ENTERPRISE_IMPORT_QUEUE_NAME,
        jobId,
        reason,
        timestamp: nowIso(),
      },
      headers: {
        'Content-Type': 'application/json',
        'X-Workflow-Source': 'enterprise-import',
      },
      retries: QSTASH_WAKE_RETRIES,
      retryDelay: process.env.IMPORT_QSTASH_WAKE_RETRY_DELAY || '1000 * pow(2, retried)',
      timeout: QSTASH_WAKE_TIMEOUT_SECONDS,
      failureCallback: getEnterpriseImportWorkflowUrl('/failure') || undefined,
      label: process.env.IMPORT_QSTASH_WAKE_LABEL || 'enterprise-import-wake',
    });
    lastQstashWakeAt = nowIso();
    lastQstashWakeError = null;
    await recordEnterpriseQueueEvent('qstash_wake_dispatched', { jobId, reason, messageId: result?.messageId || null });
    return { dispatched: true, result };
  } catch (error) {
    lastQstashWakeError = summarizeError(error);
    console.warn('[enterprise-import:qstash] wake dispatch failed:', lastQstashWakeError);
    await recordEnterpriseQueueEvent('qstash_wake_failed', { jobId, reason, error: lastQstashWakeError }).catch(() => null);
    return { dispatched: false, error: lastQstashWakeError };
  }
}

export async function reconcileEnterpriseImportQueue({ limit = RECOVERY_SCAN_LIMIT, source = 'reconcile' } = {}) {
  if (!supabase || !upstashRedis) return { scanned: 0, enqueued: 0, staleRecovered: 0 };

  const staleBefore = new Date(Date.now() - STALLED_JOB_MS).toISOString();
  let staleRecovered = 0;
  let activeCleaned = 0;

  try {
    activeCleaned = await upstashRedis.zremrangebyscore(ACTIVE_KEY, '-inf', Date.now() - STALLED_JOB_MS).catch(() => 0);
    const { data: stale, error: staleError } = await supabase
      .from('import_jobs')
      .update({ status: 'queued', updated_at: nowIso() })
      .in('status', ['counting', 'processing'])
      .lt('updated_at', staleBefore)
      .select('id');
    if (staleError) throw staleError;
    staleRecovered = (stale || []).length;
  } catch (error) {
    console.warn('[enterprise-import:queue] stale recovery failed:', summarizeError(error));
  }

  const { data, error } = await supabase
    .from('import_jobs')
    .select('id,status,created_at')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Number(limit) || RECOVERY_SCAN_LIMIT));
  if (error) throw error;

  let enqueued = 0;
  for (const job of data || []) {
    try {
      await enqueueEnterpriseImportJob(job.id, { source, reason: staleRecovered ? 'stale-recovery' : 'queue-reconcile', wake: false });
      enqueued += 1;
    } catch (enqueueError) {
      console.warn('[enterprise-import:queue] reconcile enqueue failed:', job.id, summarizeError(enqueueError));
      break;
    }
  }

  if (enqueued || staleRecovered || activeCleaned) {
    await recordEnterpriseQueueEvent('reconciled', { scanned: (data || []).length, enqueued, staleRecovered, activeCleaned, source });
    wakeEnterpriseImportWorkers('reconcile');
  }

  return { scanned: (data || []).length, enqueued, staleRecovered, activeCleaned };
}

async function readRedisNumber(fn, fallback = 0) {
  if (!upstashRedis) return fallback;
  try {
    const value = await runRedisOperation('IMPORT_QUEUE_HEALTH_READ', fn, {
      timeoutMs: Number(process.env.IMPORT_QUEUE_HEALTH_REDIS_TIMEOUT_MS || 1000),
    });
    return Number(value || 0);
  } catch (error) {
    markRedisError(error);
    return fallback;
  }
}

async function getWorkerSnapshots() {
  if (!upstashRedis) return [];
  try {
    const ids = await runRedisOperation('IMPORT_QUEUE_WORKERS_SMEMBERS', () => upstashRedis.smembers(WORKERS_KEY), {
      timeoutMs: Number(process.env.IMPORT_QUEUE_HEALTH_REDIS_TIMEOUT_MS || 1000),
    });
    const workerIds = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    const snapshots = [];
    for (const id of workerIds.slice(0, 50)) {
      const snapshot = parseJson(await runRedisOperation(
        'IMPORT_QUEUE_WORKER_GET',
        () => upstashRedis.get(workerKey(id)),
        { timeoutMs: Number(process.env.IMPORT_QUEUE_HEALTH_REDIS_TIMEOUT_MS || 1000) },
      ).catch(() => null));
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots.sort((a, b) => String(b.heartbeatAt || '').localeCompare(String(a.heartbeatAt || '')));
  } catch (error) {
    markRedisError(error);
    return [];
  }
}

async function loadEnterpriseImportQueueHealth() {
  const redis = await pingRedis();
  const [ready, delayed, active, dead, workers] = await Promise.all([
    readRedisNumber(() => upstashRedis.llen(READY_KEY)),
    readRedisNumber(() => upstashRedis.zcard(DELAYED_KEY)),
    readRedisNumber(() => upstashRedis.zcard(ACTIVE_KEY)),
    readRedisNumber(() => upstashRedis.llen(DEAD_KEY)),
    getWorkerSnapshots(),
  ]);

  let database = { queued: 0, processing: 0, failed: 0 };
  if (supabase) {
    try {
      const { data } = await supabase
        .from('import_jobs')
        .select('status')
        .in('status', ['queued', 'counting', 'processing', 'failed'])
        .limit(1000);
      const rows = data || [];
      database = {
        queued: rows.filter((row) => row.status === 'queued').length,
        processing: rows.filter((row) => ['counting', 'processing'].includes(row.status)).length,
        failed: rows.filter((row) => row.status === 'failed').length,
      };
    } catch (error) {
      database.error = summarizeError(error);
    }
  }

  return {
    queue: ENTERPRISE_IMPORT_QUEUE_NAME,
    redis,
    qstash: getQstashStatus(),
    keys: {
      prefix: PREFIX,
      ready: READY_KEY,
      delayed: DELAYED_KEY,
      active: ACTIVE_KEY,
      deadLetter: DEAD_KEY,
      events: EVENTS_KEY,
    },
    counts: {
      ready,
      delayed,
      active,
      deadLetter: dead,
      workers: workers.length,
    },
    database,
    workers,
    wake: {
      lastWakeAt,
      lastQstashWakeAt,
      lastQstashWakeError,
    },
    recentEvents: localQueueEvents.slice(0, 25),
    timestamp: nowIso(),
  };
}

export async function getEnterpriseImportQueueHealth({ refresh = false } = {}) {
  const cacheKey = 'enterprise-import:queue-health';
  if (refresh) appMemoryCache.delete(cacheKey);
  return appMemoryCache.wrap(cacheKey, loadEnterpriseImportQueueHealth, QUEUE_HEALTH_CACHE_MS);
}

export function getEnterpriseImportQueueConfig() {
  return {
    queue: ENTERPRISE_IMPORT_QUEUE_NAME,
    prefix: PREFIX,
    readyKey: READY_KEY,
    delayedKey: DELAYED_KEY,
    activeKey: ACTIVE_KEY,
    deadLetterKey: DEAD_KEY,
    eventsKey: EVENTS_KEY,
    workersKey: WORKERS_KEY,
    wakeKey: WAKE_KEY,
    qstashWakeEnabled: QSTASH_WAKE_ENABLED,
    recoveryScanLimit: RECOVERY_SCAN_LIMIT,
    stalledJobMs: STALLED_JOB_MS,
  };
}
