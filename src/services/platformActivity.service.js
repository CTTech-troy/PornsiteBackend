import { supabase } from '../config/supabase.js';
import { markRedisError, runRedisOperation, upstashRedis } from '../config/redis.js';
import { emitFinanceActivityEvent } from './financePayoutEvents.service.js';

const activityClients = new Set();
const ACTIVITY_STREAM_KEY = process.env.PLATFORM_ACTIVITY_REDIS_STREAM_KEY || 'xstream:platform-activity:events';
const ACTIVITY_STREAM_MAXLEN = Math.max(1000, Number(process.env.PLATFORM_ACTIVITY_REDIS_STREAM_MAXLEN || 10000));
const ACTIVITY_STREAM_POLL_MS = Math.max(3000, Number(process.env.PLATFORM_ACTIVITY_REDIS_POLL_MS || 5000));
const IMPORT_PROGRESS_REDIS_MIN_MS = Math.max(1000, Number(process.env.PLATFORM_ACTIVITY_IMPORT_PROGRESS_REDIS_MIN_MS || 5000));

let redisCursor = `${Date.now()}-0`;
let redisPollTimer = null;
let redisPollInFlight = false;
const lastRedisEventAt = new Map();

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' || /schema cache/i.test(String(err?.message || ''));
}

function safeJson(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return '{}';
  }
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

function normalizeStreamEntries(result) {
  if (!result) return [];
  if (!Array.isArray(result) && typeof result === 'object') {
    return Object.entries(result).map(([id, fields]) => ({ id, fields }));
  }
  if (!Array.isArray(result)) return [];
  return result.flatMap((entry) => {
    if (!Array.isArray(entry)) return [];
    if (typeof entry[0] === 'string' && entry[1] && !Array.isArray(entry[1])) {
      return [{ id: entry[0], fields: entry[1] }];
    }
    if (typeof entry[0] === 'string' && Array.isArray(entry[1])) {
      return entry[1].map((row) => ({ id: row[0], fields: row[1] }));
    }
    return [];
  });
}

async function appendRedisActivityEvent(event, body) {
  if (!upstashRedis) return false;
  const throttleKey = redisThrottleKey(event, body);
  if (throttleKey && !shouldWriteRedisEvent(throttleKey, body)) return true;
  try {
    const written = await runRedisOperation(
      'PLATFORM_ACTIVITY_XADD',
      () => upstashRedis.xadd(
        ACTIVITY_STREAM_KEY,
        '*',
        { event: safeJson({ event, body }) },
        {
          trim: {
            type: 'MAXLEN',
            comparison: '~',
            threshold: ACTIVITY_STREAM_MAXLEN,
          },
        },
      ),
      { timeoutMs: Number(process.env.PLATFORM_ACTIVITY_REDIS_TIMEOUT_MS || 1000) },
    );
    return written != null;
  } catch (error) {
    markRedisError(error);
    console.warn('[platformActivity] Redis event stream write failed:', error?.message || error);
    return false;
  }
}

function redisThrottleKey(event, body) {
  if (body?.eventType !== 'enterprise_import_progress') return null;
  const jobId = body?.payload?.jobId || body?.jobId || body?.targetId;
  return jobId ? `${event}:${jobId}` : event;
}

function shouldWriteRedisEvent(key, body) {
  const status = String(body?.payload?.status || body?.status || '').toLowerCase();
  if (['queued', 'completed', 'failed', 'cancelled'].includes(status)) return true;
  const now = Date.now();
  const last = Number(lastRedisEventAt.get(key) || 0);
  if (now - last < IMPORT_PROGRESS_REDIS_MIN_MS) return false;
  lastRedisEventAt.set(key, now);
  return true;
}

function writeSse(client, event, body) {
  try {
    client.res.write(`event: ${event}\ndata: ${safeJson(body)}\n\n`);
    return true;
  } catch {
    activityClients.delete(client);
    return false;
  }
}

async function pollRedisActivityEvents(client, cursor) {
  if (!upstashRedis) return cursor;
  const start = cursor ? `(${cursor}` : `${Date.now()}-0`;
  try {
    const result = await runRedisOperation(
      'PLATFORM_ACTIVITY_XRANGE',
      () => upstashRedis.xrange(ACTIVITY_STREAM_KEY, start, '+', 100),
      { timeoutMs: Number(process.env.PLATFORM_ACTIVITY_REDIS_TIMEOUT_MS || 1000) },
    );
    let nextCursor = cursor;
    for (const entry of normalizeStreamEntries(result)) {
      const payload = safeJsonParse(entry.fields?.event);
      if (!payload?.event || !payload?.body) continue;
      if (!writeSse(client, payload.event, payload.body)) return nextCursor || entry.id;
      nextCursor = entry.id;
    }
    return nextCursor;
  } catch (error) {
    markRedisError(error);
    return cursor;
  }
}

async function pollRedisActivityForAllClients() {
  if (!activityClients.size || redisPollInFlight) return;
  redisPollInFlight = true;
  try {
    redisCursor = await pollRedisActivityEvents({
      res: {
        write(payload) {
          for (const client of Array.from(activityClients)) {
            try {
              client.res.write(payload);
            } catch {
              activityClients.delete(client);
            }
          }
          return true;
        },
      },
    }, redisCursor);
  } finally {
    redisPollInFlight = false;
  }
}

function ensureRedisPoller() {
  if (!upstashRedis || redisPollTimer || !activityClients.size) return;
  redisPollTimer = setInterval(() => {
    pollRedisActivityForAllClients().catch(() => {});
  }, ACTIVITY_STREAM_POLL_MS);
  redisPollTimer.unref?.();
}

function stopRedisPollerIfIdle() {
  if (activityClients.size || !redisPollTimer) return;
  clearInterval(redisPollTimer);
  redisPollTimer = null;
}

export function subscribePlatformActivityEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client = { res };
  activityClients.add(client);
  res.write(`event: activity:connected\ndata: ${safeJson({ ok: true, ts: Date.now() })}\n\n`);
  ensureRedisPoller();
  const heartbeat = setInterval(() => {
    res.write(`event: activity:heartbeat\ndata: ${safeJson({ ts: Date.now() })}\n\n`);
  }, 25_000);
  heartbeat.unref?.();
  req.on('close', () => {
    clearInterval(heartbeat);
    activityClients.delete(client);
    stopRedisPollerIfIdle();
  });
}

export function emitPlatformActivity(io, eventType, payload = {}) {
  const event = `activity:${eventType}`;
  const body = { eventType, ...payload, ts: Date.now() };
  for (const client of Array.from(activityClients)) {
    writeSse(client, event, body);
  }
  if (upstashRedis) {
    appendRedisActivityEvent(event, body).catch(() => {});
  }
  emitFinanceActivityEvent(io, event, body);
}

export async function writePlatformActivityEvent({
  eventType,
  title,
  message,
  actorId = null,
  targetType = null,
  targetId = null,
  payload = {},
  io = null,
}) {
  if (supabase) {
    const { error } = await supabase.from('platform_activity_events').insert({
      event_type: eventType,
      title,
      message,
      actor_id: actorId,
      target_type: targetType,
      target_id: targetId,
      payload,
    });
    if (error && !isMissingTable(error)) {
      console.warn('[platformActivity] insert failed:', error.message);
    }
  }
  emitPlatformActivity(io, eventType, { title, message, actorId, targetType, targetId, payload });
}

export async function listPlatformActivityEvents({ limit = 50, offset = 0 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('platform_activity_events')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return data || [];
}
