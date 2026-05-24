import { supabase } from '../config/supabase.js';

const clients = new Set();

function isMissingTableOrColumn(err) {
  return (
    err?.code === '42P01' ||
    err?.code === '42703' ||
    err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'))
  );
}

function safeJson(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return '{}';
  }
}

export function subscribeFinanceEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client = { res };
  clients.add(client);
  res.write(`event: finance:connected\ndata: ${safeJson({ ok: true, ts: Date.now() })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`event: finance:heartbeat\ndata: ${safeJson({ ts: Date.now() })}\n\n`);
  }, 25_000);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

export function emitFinancePayoutEvent(io, eventName, payout, extra = {}) {
  const event = eventName || 'finance:payout-updated';
  const payload = {
    event,
    payout,
    ...extra,
    ts: Date.now(),
  };

  for (const client of Array.from(clients)) {
    try {
      client.res.write(`event: ${event}\ndata: ${safeJson(payload)}\n\n`);
    } catch {
      clients.delete(client);
    }
  }

  try {
    io?.emit?.(event, payload);
  } catch (_) {}
}

export function emitFinanceActivityEvent(io, eventName, activity, extra = {}) {
  const event = eventName || 'finance:activity-created';
  const payload = {
    event,
    activity,
    ...extra,
    ts: Date.now(),
  };

  for (const client of Array.from(clients)) {
    try {
      client.res.write(`event: ${event}\ndata: ${safeJson(payload)}\n\n`);
    } catch {
      clients.delete(client);
    }
  }

  try {
    io?.emit?.(event, payload);
  } catch (_) {}
}

export async function writeFinanceActivityEvent(activity = {}, { io = null } = {}) {
  if (!supabase || !activity.eventType) return null;

  const row = {
    event_type: activity.eventType,
    actor_type: activity.actorType || 'system',
    actor_id: activity.actorId || null,
    user_id: activity.userId || null,
    creator_id: activity.creatorId || null,
    product_type: activity.productType || null,
    product_id: activity.productId || null,
    amount_usd: activity.amountUsd == null ? null : Number(activity.amountUsd || 0),
    amount_tokens: activity.amountTokens == null ? null : Number(activity.amountTokens || 0),
    provider: activity.provider || null,
    reference: activity.reference || null,
    status: activity.status || null,
    metadata: activity.metadata || {},
  };

  const { data, error } = await supabase
    .from('finance_activity_events')
    .insert(row)
    .select()
    .maybeSingle();

  if (error) {
    if (!isMissingTableOrColumn(error)) {
      console.warn('[finance] activity event insert failed:', error.message || error);
    }
    return null;
  }

  emitFinanceActivityEvent(io, 'finance:activity-created', data);
  return data;
}

export async function listFinanceActivityEvents({ page = 1, limit = 30, eventType = '' } = {}) {
  if (!supabase) return { events: [], total: 0, page, limit };
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const from = (safePage - 1) * safeLimit;
  const to = from + safeLimit - 1;

  let query = supabase
    .from('finance_activity_events')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (eventType) query = query.eq('event_type', eventType);

  const { data, error, count } = await query;
  if (error) {
    if (isMissingTableOrColumn(error)) return { events: [], total: 0, page: safePage, limit: safeLimit };
    throw error;
  }

  return { events: data || [], total: count || 0, page: safePage, limit: safeLimit };
}

export async function writeFinancePayoutLog(payout, status, extra = {}) {
  if (!supabase || !payout) return null;

  const row = {
    payout_request_id: payout.id || null,
    creator_id: payout.creator_id || null,
    creator_name: payout.creator_name || payout.account_name || null,
    amount_usd: Number(payout.amount_usd || 0),
    amount_ngn: payout.amount_ngn == null ? null : Number(payout.amount_ngn || 0),
    transaction_reference:
      extra.transactionReference ||
      payout.paystack_transaction_reference ||
      payout.reference_id ||
      null,
    payout_status: status || payout.status || 'pending',
    payment_date: extra.paymentDate || payout.paid_at || payout.processed_at || null,
    provider: extra.provider || payout.payment_provider || 'paystack',
    error_message: extra.errorMessage || payout.failure_reason || payout.rejection_reason || null,
    metadata: {
      bankName: payout.bank_name || null,
      bankCode: payout.bank_code || null,
      accountName: payout.account_name || null,
      accountNumber: payout.account_number ? String(payout.account_number).slice(-4).padStart(String(payout.account_number).length, '*') : null,
      ...extra.metadata,
    },
  };

  const { data, error } = await supabase
    .from('finance_payout_logs')
    .insert(row)
    .select()
    .maybeSingle();

  if (error && !isMissingTableOrColumn(error)) {
    console.warn('[finance] payout log insert failed:', error.message || error);
  }
  return data || null;
}
