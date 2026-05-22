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
