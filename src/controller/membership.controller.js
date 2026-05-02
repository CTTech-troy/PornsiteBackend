/**
 * membership.controller.js
 *
 * Manages user membership plans and coin balance.
 *
 * Plans:
 *   coins_30   — 30 coins  / $0.99  / 30 days
 *   coins_60   — 60 coins  / $1.99  / 30 days
 *   coins_120  — 120 coins / $5.99  / 30 days
 *   unlimited  — 0 coins   / $50.00 / 30 days  (unlimited platform access)
 *
 * After expiry the user enters a 3-day grace period.
 * Once grace ends, active_plan reverts to 'basic'.
 */

import { supabase, isConfigured } from '../config/supabase.js';
import { getFirebaseRtdbPlan } from './membershipPlans.controller.js';

const GRACE_PERIOD_DAYS = 3;

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

// Static plan definitions — used as fallback when the DB table doesn't exist yet
// and as the source of truth for plan metadata throughout the codebase.
const STATIC_PLANS = [
  { id: 'coins_30',  name: '30 Coins',          description: '30 coins + 30 days premium access',       coins: 30,  price_usd: 0.99,  price_ngn: 1500,  duration_days: 30, is_active: true },
  { id: 'coins_60',  name: '60 Coins',           description: '60 coins + 30 days premium access',       coins: 60,  price_usd: 1.99,  price_ngn: 3000,  duration_days: 30, is_active: true },
  { id: 'coins_120', name: '120 Coins',           description: '120 coins + 30 days premium access',      coins: 120, price_usd: 5.99,  price_ngn: 9000,  duration_days: 30, is_active: true },
  { id: 'unlimited', name: 'Unlimited Monthly',  description: 'Unlimited premium access for 30 days',    coins: 0,   price_usd: 50.00, price_ngn: 75000, duration_days: 30, is_active: true },
];

/**
 * Return all active membership plans.
 * Tries the Supabase table first; falls back to static definitions when the
 * table doesn't exist yet (e.g. migration pending).
 */
export async function getMembershipPlans() {
  if (!isConfigured()) return STATIC_PLANS;

  const { data, error } = await supabase
    .from('membership_plans')
    .select('id, name, description, coins, price_usd, price_ngn, duration_days')
    .eq('is_active', true)
    .order('price_usd', { ascending: true });

  if (error) {
    // Table missing (migration not applied) — return static definitions so the
    // UI works immediately. Log the error so it's visible in dev.
    console.warn('[membership] DB query failed, using static plans:', error.message);
    return STATIC_PLANS;
  }
  return data?.length ? data : STATIC_PLANS;
}

// ---------------------------------------------------------------------------
// User membership status
// ---------------------------------------------------------------------------

/**
 * Return the current membership state for a user.
 * Automatically reverts the plan to 'basic' if grace has elapsed.
 *
 * @returns {{
 *   userId, plan, planStatus, coinBalance,
 *   expiresAt, graceEndsAt, daysLeft, graceDaysLeft
 * }}
 */
export async function getUserMembership(userId) {
  if (!isConfigured()) throw new Error('Supabase not configured');

  // Ensure the user row exists before reading
  await supabase.from('users').upsert({ id: userId }, { onConflict: 'id' });

  const { data: user, error } = await supabase
    .from('users')
    .select('id, coin_balance, active_plan, plan_expires_at, plan_grace_ends_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!user) throw new Error('User not found');

  const now         = new Date();
  const expiresAt   = user.plan_expires_at   ? new Date(user.plan_expires_at)   : null;
  const graceEndsAt = user.plan_grace_ends_at ? new Date(user.plan_grace_ends_at) : null;

  let planStatus = 'basic';

  if (user.active_plan !== 'basic') {
    if (expiresAt && now < expiresAt) {
      planStatus = 'active';
    } else if (graceEndsAt && now < graceEndsAt) {
      planStatus = 'grace';
    } else {
      // Grace period has elapsed — silently revert to basic
      planStatus = 'expired';
      await _revertToBasicPlan(userId);
      user.active_plan = 'basic';
    }
  }

  const daysLeft = expiresAt && planStatus === 'active'
    ? Math.max(0, Math.ceil((expiresAt - now) / 86_400_000))
    : 0;

  const graceDaysLeft = graceEndsAt && planStatus === 'grace'
    ? Math.max(0, Math.ceil((graceEndsAt - now) / 86_400_000))
    : 0;

  return {
    userId,
    plan:         user.active_plan,
    planStatus,                      // 'basic' | 'active' | 'grace' | 'expired'
    coinBalance:  user.coin_balance ?? 0,
    expiresAt:    user.plan_expires_at   ?? null,
    graceEndsAt:  user.plan_grace_ends_at ?? null,
    daysLeft,
    graceDaysLeft,
  };
}

// ---------------------------------------------------------------------------
// Idempotency check — prevent duplicate plan activation on webhook retries
// ---------------------------------------------------------------------------

/**
 * Returns true if the payment_reference was already processed (i.e. a
 * membership row already exists for it). Used by webhook handlers to skip
 * duplicate Paystack / Monnify delivery attempts.
 *
 * @param {string} reference — Paystack or Monnify payment reference
 * @returns {Promise<boolean>}
 */
export async function isPaymentAlreadyProcessed(reference) {
  if (!reference || !isConfigured()) return false;
  try {
    const { data } = await supabase
      .from('user_memberships')
      .select('id')
      .eq('payment_reference', reference)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Activate plan after successful payment (called from webhook handler)
// ---------------------------------------------------------------------------

/**
 * Credit coins and activate the plan for a user after a confirmed payment.
 *
 * @param {string} userId
 * @param {string} planId  — e.g. 'coins_30', 'unlimited'
 * @param {{ reference: string, provider: string, amountPaidUsd: number }} payment
 */
export async function activatePlan(userId, planId, { reference, provider, amountPaidUsd }) {
  if (!isConfigured()) throw new Error('Supabase not configured');

  // Fetch plan definition — try Supabase first, then Firebase RTDB for admin-managed plans
  const { data: supabasePlan, error: planErr } = await supabase
    .from('membership_plans')
    .select('*')
    .eq('id', planId)
    .maybeSingle();

  if (planErr) throw planErr;

  let plan = supabasePlan;
  if (!plan) {
    const rtdbPlan = await getFirebaseRtdbPlan(planId);
    if (rtdbPlan) {
      const durationDays = _parseDurationDays(rtdbPlan.duration);
      plan = { id: planId, name: rtdbPlan.title || planId, description: rtdbPlan.description || '', coins: 0, duration_days: durationDays };
    }
  }

  if (!plan) throw new Error(`Unknown plan: "${planId}"`);

  const now         = new Date();
  const expiresAt   = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + plan.duration_days);

  const graceEndsAt = new Date(expiresAt);
  graceEndsAt.setDate(graceEndsAt.getDate() + GRACE_PERIOD_DAYS);

  // Ensure user row exists
  await supabase.from('users').upsert({ id: userId }, { onConflict: 'id' });

  // Update plan fields on the user row
  const { error: userUpdateErr } = await supabase
    .from('users')
    .update({
      active_plan:        planId,
      plan_expires_at:    expiresAt.toISOString(),
      plan_grace_ends_at: graceEndsAt.toISOString(),
    })
    .eq('id', userId);

  if (userUpdateErr) throw userUpdateErr;

  // Atomically add coins via RPC (mirrors credit_wallet pattern)
  if (plan.coins > 0) {
    const { error: coinErr } = await supabase.rpc('add_coins', {
      p_user_id: userId,
      p_amount:  plan.coins,
    });
    if (coinErr) throw new Error(`Failed to credit coins: ${coinErr.message}`);
  }

  // Record purchase history
  const { data: membership, error: memErr } = await supabase
    .from('user_memberships')
    .insert({
      user_id:           userId,
      plan_id:           planId,
      coins_received:    plan.coins,
      status:            'active',
      payment_reference: reference,
      payment_provider:  provider,
      amount_paid_usd:   amountPaidUsd,
      started_at:        now.toISOString(),
      expires_at:        expiresAt.toISOString(),
      grace_ends_at:     graceEndsAt.toISOString(),
    })
    .select()
    .maybeSingle();

  if (memErr) throw memErr;

  return {
    membership,
    plan,
    coinsAdded: plan.coins,
    expiresAt:  expiresAt.toISOString(),
    graceEndsAt: graceEndsAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Coin spending (for gifts / tips)
// ---------------------------------------------------------------------------

/**
 * Deduct coins from a user atomically.
 * Throws if the user has insufficient coins.
 */
export async function spendCoins(userId, amount) {
  if (!isConfigured()) throw new Error('Supabase not configured');

  const { data: newBalance, error } = await supabase.rpc('spend_coins', {
    p_user_id: userId,
    p_amount:  Number(amount),
  });

  if (error) {
    if (/insufficient coins/i.test(error.message)) throw new Error('Insufficient coins');
    throw error;
  }

  return { coinBalance: Number(newBalance) };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a duration string like "30 Days" or "Monthly" into a number of days.
 * Defaults to 30 if unparseable.
 * @private
 */
function _parseDurationDays(duration) {
  if (typeof duration === 'number') return duration;
  if (!duration) return 30;
  const match = String(duration).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 30;
}

/**
 * Revert the user's plan to 'basic' (called when grace period expires).
 * @private
 */
async function _revertToBasicPlan(userId) {
  const { error } = await supabase
    .from('users')
    .update({
      active_plan:        'basic',
      plan_expires_at:    null,
      plan_grace_ends_at: null,
    })
    .eq('id', userId);

  if (error) console.error('[membership] Failed to revert plan for', userId, error.message);

  // Mark the most recent active membership row as expired
  await supabase
    .from('user_memberships')
    .update({ status: 'expired' })
    .eq('user_id', userId)
    .eq('status', 'active');
}
