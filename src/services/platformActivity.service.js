import { supabase } from '../config/supabase.js';
import { emitFinanceActivityEvent } from './financePayoutEvents.service.js';

const activityClients = new Set();

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
  const heartbeat = setInterval(() => {
    res.write(`event: activity:heartbeat\ndata: ${safeJson({ ts: Date.now() })}\n\n`);
  }, 25_000);
  heartbeat.unref?.();
  req.on('close', () => {
    clearInterval(heartbeat);
    activityClients.delete(client);
  });
}

export function emitPlatformActivity(io, eventType, payload = {}) {
  const event = `activity:${eventType}`;
  const body = { eventType, ...payload, ts: Date.now() };
  for (const client of Array.from(activityClients)) {
    try {
      client.res.write(`event: ${event}\ndata: ${safeJson(body)}\n\n`);
    } catch {
      activityClients.delete(client);
    }
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
