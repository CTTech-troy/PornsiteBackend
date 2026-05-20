import { supabase, isConfigured } from '../config/supabase.js';
import { getUserMembership, spendCoins } from '../controller/membership.controller.js';

export const RANDOM_CHAT_BILLING_INTERVAL_MS = 30_000;
export const RANDOM_CHAT_BILLING_COST = 10;
export const RANDOM_CHAT_LOW_BALANCE = 20;

const MISSING_SCHEMA_CODES = new Set(['42P01', '42883', 'PGRST202', 'PGRST116']);

function isMissingSchema(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    MISSING_SCHEMA_CODES.has(err?.code) ||
    msg.includes('does not exist') ||
    msg.includes('could not find the function') ||
    msg.includes('schema cache')
  );
}

function insufficientCoinsError(balance = 0) {
  const err = new Error('You have run out of coins. Purchase a membership to continue using Random Chat.');
  err.code = 'INSUFFICIENT_COINS';
  err.balance = Number(balance) || 0;
  return err;
}

function isPaidMembership(membership) {
  const plan = String(membership?.plan || 'basic').toLowerCase();
  const status = String(membership?.planStatus || '').toLowerCase();
  return plan !== 'basic' && (status === 'active' || status === 'grace');
}

export async function getRandomChatAccess(userId) {
  if (!userId) return { allowed: false, reason: 'AUTH_REQUIRED', balance: 0, membershipActive: false };
  if (!isConfigured() || !supabase) {
    if (process.env.NODE_ENV !== 'production') {
      return {
        allowed: true,
        reason: 'DEV_BILLING_BYPASS',
        balance: 999999,
        membershipActive: true,
        plan: 'dev',
        planStatus: 'active',
        cost: RANDOM_CHAT_BILLING_COST,
        intervalMs: RANDOM_CHAT_BILLING_INTERVAL_MS,
        lowBalanceThreshold: RANDOM_CHAT_LOW_BALANCE,
      };
    }
    return { allowed: false, reason: 'BILLING_UNAVAILABLE', balance: 0, membershipActive: false };
  }

  try {
    const membership = await getUserMembership(userId);
    const membershipActive = isPaidMembership(membership);
    const balance = Number(membership?.coinBalance || 0);
    return {
      allowed: membershipActive || balance >= RANDOM_CHAT_BILLING_COST,
      reason: membershipActive || balance >= RANDOM_CHAT_BILLING_COST ? 'OK' : 'INSUFFICIENT_COINS',
      balance,
      membershipActive,
      plan: membership?.plan || 'basic',
      planStatus: membership?.planStatus || 'basic',
      cost: RANDOM_CHAT_BILLING_COST,
      intervalMs: RANDOM_CHAT_BILLING_INTERVAL_MS,
      lowBalanceThreshold: RANDOM_CHAT_LOW_BALANCE,
    };
  } catch (err) {
    console.warn('[randomChatBilling] access check failed:', err?.message || err);
    return { allowed: false, reason: 'BILLING_UNAVAILABLE', balance: 0, membershipActive: false };
  }
}

export async function chargeRandomChatInterval({ userId, roomId, peerUserId, intervalIndex }) {
  const access = await getRandomChatAccess(userId);
  if (access.membershipActive) {
    return { charged: false, balance: access.balance, membershipActive: true, plan: access.plan };
  }
  if (!access.allowed) throw insufficientCoinsError(access.balance);

  if (!isConfigured() || !supabase) throw insufficientCoinsError(access.balance);

  const amount = RANDOM_CHAT_BILLING_COST;
  const rpc = await supabase.rpc('spend_random_chat_coins', {
    p_user_id: userId,
    p_amount: amount,
    p_room_id: roomId,
    p_peer_user_id: peerUserId || null,
    p_interval_index: Number(intervalIndex) || 1,
  });

  if (!rpc.error) {
    return {
      charged: true,
      balance: Number(rpc.data || 0),
      membershipActive: false,
      amount,
    };
  }

  if (!isMissingSchema(rpc.error)) {
    if (/insufficient/i.test(rpc.error.message || '')) throw insufficientCoinsError(access.balance);
    throw rpc.error;
  }

  const result = await spendCoins(userId, amount).catch((err) => {
    if (/insufficient/i.test(err?.message || '')) throw insufficientCoinsError(access.balance);
    throw err;
  });

  supabase.from('token_transactions').insert({
    user_id: userId,
    type: 'adjustment',
    amount: -amount,
    status: 'completed',
    metadata: {
      reason: 'random_chat_interval',
      room_id: roomId,
      peer_user_id: peerUserId || null,
      interval_index: Number(intervalIndex) || 1,
      interval_seconds: RANDOM_CHAT_BILLING_INTERVAL_MS / 1000,
    },
  }).then(() => {}, (err) => {
    console.warn('[randomChatBilling] token ledger fallback failed:', err?.message || err);
  });

  return {
    charged: true,
    balance: Number(result?.coinBalance || 0),
    membershipActive: false,
    amount,
  };
}

export async function createUsageRecord({
  roomId,
  userId,
  peerUserId,
  startedAt,
  connectedAt = null,
  membershipBypass = false,
  startingBalance = 0,
}) {
  if (!isConfigured() || !supabase || !roomId || !userId) return null;
  const row = {
    room_id: roomId,
    user_id: userId,
    peer_user_id: peerUserId || null,
    started_at: new Date(startedAt || Date.now()).toISOString(),
    connected_at: connectedAt ? new Date(connectedAt).toISOString() : null,
    membership_bypass: membershipBypass === true,
    starting_balance: Number(startingBalance) || 0,
    billing_interval_seconds: RANDOM_CHAT_BILLING_INTERVAL_MS / 1000,
    coin_cost_per_interval: RANDOM_CHAT_BILLING_COST,
    status: 'active',
  };

  const { data, error } = await supabase
    .from('random_chat_usage')
    .insert(row)
    .select('id')
    .maybeSingle();

  if (error) {
    if (!isMissingSchema(error)) console.warn('[randomChatBilling] usage insert failed:', error.message);
    return null;
  }
  return data?.id || null;
}

export async function finalizeUsageRecord({
  id,
  roomId,
  userId,
  endedAt,
  startedAt,
  connectedAt,
  coinsSpent = 0,
  billingEvents = [],
  endReason = 'ended',
  status = 'ended',
}) {
  if (!isConfigured() || !supabase || (!id && (!roomId || !userId))) return;

  const endMs = Number(endedAt || Date.now());
  const startMs = Number(startedAt || endMs);
  const connectedMs = Number(connectedAt || startMs);
  const durationSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const billableSeconds = Math.max(0, Math.floor((endMs - connectedMs) / 1000));
  const updates = {
    ended_at: new Date(endMs).toISOString(),
    duration_seconds: durationSeconds,
    billable_seconds: billableSeconds,
    coins_spent: Number(coinsSpent) || 0,
    billing_events: billingEvents,
    end_reason: String(endReason || 'ended').slice(0, 120),
    status,
  };

  const query = supabase.from('random_chat_usage').update(updates);
  const result = id
    ? await query.eq('id', id)
    : await query.eq('room_id', roomId).eq('user_id', userId);

  if (result.error && !isMissingSchema(result.error)) {
    console.warn('[randomChatBilling] usage finalize failed:', result.error.message);
  }
}
