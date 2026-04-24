import { supabase, isConfigured } from '../config/supabase.js';

// ---------------------------------------------------------------------------
// getTokenBalance
// ---------------------------------------------------------------------------
export async function getTokenBalance(userId) {
  if (!userId) throw new Error('userId required');
  if (!isConfigured() || !supabase) return 0;

  try {
    const { data, error } = await supabase
      .from('users')
      .select('coin_balance')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      if (/column.*does not exist|coin_balance/i.test(error.message ?? '')) return 0;
      throw error;
    }
    return Number(data?.coin_balance ?? 0);
  } catch (err) {
    if (/column.*does not exist|coin_balance/i.test(err.message ?? '')) return 0;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// addTokens — called by payment webhook after a successful token purchase.
// Tries the add_coins RPC first; falls back to a direct UPDATE if the RPC
// hasn't been deployed yet.
// ---------------------------------------------------------------------------
export async function addTokens(userId, amount, { reference, paymentAmount, currency = 'USD' } = {}) {
  if (!userId || !amount) throw new Error('userId and amount required');
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');

  const n = Number(amount);
  let newBalance;

  // Try RPC
  const { data: rpcData, error: rpcErr } = await supabase.rpc('add_coins', {
    p_user_id: userId,
    p_amount:  n,
  });

  if (rpcErr) {
    // RPC not deployed yet — fall back to read-then-write
    const { data: row } = await supabase.from('users').select('coin_balance').eq('id', userId).maybeSingle();
    const next = (Number(row?.coin_balance) || 0) + n;
    const { error: updErr } = await supabase.from('users').update({ coin_balance: next }).eq('id', userId);
    if (updErr) throw updErr;
    newBalance = next;
  } else {
    newBalance = Number(rpcData);
  }

  // Log purchase (best-effort)
  ;(async () => {
    const { error } = await supabase.from('token_transactions').insert({
      user_id:          userId,
      type:             'purchase',
      amount:           n,
      payment_amount:   paymentAmount ?? null,
      payment_currency: currency,
      status:           'completed',
      reference:        reference ?? null,
      metadata:         { package: `tokens_${n}` },
    });
    if (error) console.warn('[tokens] purchase log failed:', error?.message);
  })();

  return newBalance;
}

// ---------------------------------------------------------------------------
// sendGift — deduct coin_balance and record the gift.
// Uses a direct UPDATE with a balance guard (no RPC required).
// The .gte() filter makes the deduction atomic at the Postgres row level:
// only rows where coin_balance >= price are touched, preventing overdrawing.
// ---------------------------------------------------------------------------
export async function sendGift({
  userId,
  senderName,
  creatorId,
  streamId,
  gift,   // { id, name, emoji, price }
}) {
  if (!userId || !creatorId || !streamId || !gift)
    throw new Error('userId, creatorId, streamId and gift are required');
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');

  const price = Number(gift.price);

  // Read current balance first so we can compute the new value
  const { data: userRow, error: readErr } = await supabase
    .from('users')
    .select('coin_balance')
    .eq('id', userId)
    .maybeSingle();

  if (readErr) throw readErr;

  const currentBalance = Number(userRow?.coin_balance ?? 0);

  if (currentBalance < price) {
    const err = new Error('Insufficient token balance. Please buy more tokens to send this gift.');
    err.code = 'INSUFFICIENT_TOKENS';
    throw err;
  }

  // Deduct atomically: only update if coin_balance is still >= price
  const { data: updated, error: updateErr } = await supabase
    .from('users')
    .update({ coin_balance: currentBalance - price })
    .eq('id', userId)
    .gte('coin_balance', price)
    .select('coin_balance')
    .maybeSingle();

  if (updateErr) throw updateErr;

  if (!updated) {
    // Balance dropped between read and update (concurrent request)
    const err = new Error('Insufficient token balance. Please try again.');
    err.code = 'INSUFFICIENT_TOKENS';
    throw err;
  }

  const newBalance = Number(updated.coin_balance);

  // Log transaction (best-effort — don't fail the gift if logging errors)
  ;(async () => {
    const { error } = await supabase.from('token_transactions').insert({
      user_id:  userId,
      type:     'gift_sent',
      amount:   price,
      status:   'completed',
      metadata: {
        gift_id:    gift.id,
        gift_name:  gift.name,
        gift_emoji: gift.emoji,
        stream_id:  streamId,
        creator_id: creatorId,
        sender_name: senderName ?? null,
      },
    });
    if (error) console.warn('[tokens] gift_sent log failed:', error?.message);
  })();

  return { newBalance, giftId: null };
}

// ---------------------------------------------------------------------------
// TOKEN_PACKAGES
// ---------------------------------------------------------------------------
export const TOKEN_PACKAGES = [
  { id: 'tokens_30',  tokens: 30,  priceUsd: 0.99,  priceNgn: 1499  },
  { id: 'tokens_100', tokens: 100, priceUsd: 2.99,  priceNgn: 4499  },
  { id: 'tokens_300', tokens: 300, priceUsd: 7.99,  priceNgn: 11999 },
];
