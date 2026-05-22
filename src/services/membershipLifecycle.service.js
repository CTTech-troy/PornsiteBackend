import { randomUUID } from 'crypto';
import { supabase, isConfigured } from '../config/supabase.js';
import { createCheckout } from './paymentServiceClient.js';
import { creditCoins, getCoinWallet } from './coinWallet.service.js';

const GRACE_PERIOD_DAYS = Number(process.env.MEMBERSHIP_GRACE_PERIOD_DAYS || 3);
const NGN_PER_USD = Number(process.env.NGN_PER_USD || 1600);
const LEGACY_COIN_PLAN_IDS = new Set(['coins_30', 'coins_60', 'coins_120']);

const STATIC_MEMBERSHIP_PLANS = [
  {
    id: 'unlimited',
    name: 'Unlimited Monthly',
    description: 'Unlimited premium access for 30 days',
    price_usd: 50,
    price_ngn: 75000,
    currency: 'USD',
    duration_days: 30,
    duration_type: 'days',
    duration_value: 30,
    features: ['Unlimited premium access'],
    is_active: true,
  },
];

function isMissingDbFeature(error) {
  const message = String(error?.message || '');
  return (
    error?.code === '42883' ||
    error?.code === '42P01' ||
    error?.code === '42703' ||
    error?.code === 'PGRST200' ||
    error?.code === 'PGRST202' ||
    /schema cache|function .* does not exist|does not exist|could not find/i.test(message)
  );
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function money(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function assertPaymentAmountMatches({ paidAmount, expectedAmount, currency, planId }) {
  if (paidAmount == null) return;
  const paid = Number(paidAmount);
  const expected = Number(expectedAmount || 0);
  const tolerance = String(currency || '').toUpperCase() === 'NGN' ? 1 : 0.01;
  if (!Number.isFinite(paid) || Math.abs(paid - expected) > tolerance) {
    const err = new Error(`Payment amount mismatch for membership plan ${planId}`);
    err.code = 'PAYMENT_AMOUNT_MISMATCH';
    err.details = { paidAmount: paid, expectedAmount: expected, currency };
    throw err;
  }
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeDurationType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['days', 'weeks', 'months', 'years'].includes(v)) return v;
  return 'days';
}

function parseDurationInput(raw, fallbackDays = 30) {
  if (typeof raw === 'number') return { durationType: 'days', durationValue: Math.max(1, Math.floor(raw)) };
  const text = String(raw || '').trim().toLowerCase();
  const match = text.match(/(\d+)/);
  const amount = match ? Math.max(1, parseInt(match[1], 10)) : 1;
  if (/year|annual/.test(text)) return { durationType: 'years', durationValue: amount };
  if (/month|monthly/.test(text)) return { durationType: 'months', durationValue: amount };
  if (/week|weekly/.test(text)) return { durationType: 'weeks', durationValue: amount };
  if (/day|daily/.test(text)) return { durationType: 'days', durationValue: amount };
  return { durationType: 'days', durationValue: Math.max(1, fallbackDays) };
}

export function calculateMembershipExpiration(start, durationType = 'days', durationValue = 30) {
  const expires = new Date(start || Date.now());
  const value = Math.max(1, Math.floor(Number(durationValue) || 1));
  switch (normalizeDurationType(durationType)) {
    case 'years':
      expires.setFullYear(expires.getFullYear() + value);
      break;
    case 'months':
      expires.setMonth(expires.getMonth() + value);
      break;
    case 'weeks':
      expires.setDate(expires.getDate() + value * 7);
      break;
    default:
      expires.setDate(expires.getDate() + value);
      break;
  }
  return expires;
}

function durationLabel(type, value, fallback = '') {
  if (fallback) return fallback;
  const singular = String(type || 'days').replace(/s$/, '');
  return `${value} ${Number(value) === 1 ? singular : `${singular}s`}`;
}

export function normalizeMembershipPlan(row) {
  if (!row) return null;
  const parsed = parseDurationInput(row.duration_label || row.duration || row.duration_days, toNumber(row.duration_days, 30));
  const durationType = normalizeDurationType(row.duration_type || parsed.durationType);
  const durationValue = Math.max(1, toNumber(row.duration_value || parsed.durationValue, toNumber(row.duration_days, 30)));
  const features = Array.isArray(row.features)
    ? row.features
    : parseJson(row.features, []);
  const currency = String(row.currency || 'USD').toUpperCase();
  const displayPrice = row.price ?? (currency === 'NGN' ? row.price_ngn : row.price_usd) ?? 0;
  return {
    id: String(row.id),
    name: String(row.name || row.title || row.id),
    title: String(row.name || row.title || row.id),
    description: String(row.description || ''),
    price: money(displayPrice),
    price_usd: money(row.price_usd ?? row.price ?? 0),
    price_ngn: money(row.price_ngn ?? 0),
    currency,
    durationType,
    durationValue,
    duration: durationLabel(durationType, durationValue, row.duration_label || row.duration || ''),
    duration_days: toNumber(row.duration_days, durationType === 'days' ? durationValue : 30),
    features: Array.isArray(features) ? features : [],
    badge: row.badge || null,
    permissions: parseJson(row.permissions, {}),
    accessPermissions: parseJson(row.permissions, {}),
    limits: parseJson(row.limits, {}),
    creatorBenefits: parseJson(row.creator_benefits, {}),
    aiAccess: parseJson(row.ai_access, {}),
    visibilityPriority: toNumber(row.visibility_priority, 0),
    coinBonus: money(row.coin_bonus ?? row.coins ?? 0),
    coins: money(row.coin_bonus ?? row.coins ?? 0),
    isRecurring: row.is_recurring === true,
    isActive: row.is_active !== false && !row.archived_at,
    image: row.image_url || row.image || null,
    sortOrder: toNumber(row.sort_order, 0),
    archivedAt: row.archived_at || null,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

export async function getMembershipPlans({ includeInactive = false, includeArchived = false } = {}) {
  if (!isConfigured() || !supabase) return STATIC_MEMBERSHIP_PLANS.map(normalizeMembershipPlan);
  try {
    let query = supabase.from('membership_plans').select('*').order('sort_order', { ascending: true }).order('price_usd', { ascending: true });
    if (!includeInactive) query = query.eq('is_active', true);
    const { data, error } = await query;
    if (error) {
      if (isMissingDbFeature(error)) return STATIC_MEMBERSHIP_PLANS.map(normalizeMembershipPlan);
      throw error;
    }
    const plans = (data || [])
      .filter((row) => includeArchived || !row.archived_at)
      .filter((row) => includeInactive || !LEGACY_COIN_PLAN_IDS.has(String(row.id)))
      .map(normalizeMembershipPlan)
      .filter(Boolean);
    return plans.length ? plans : STATIC_MEMBERSHIP_PLANS.map(normalizeMembershipPlan);
  } catch (error) {
    if (isMissingDbFeature(error)) return STATIC_MEMBERSHIP_PLANS.map(normalizeMembershipPlan);
    throw error;
  }
}

export async function getMembershipPlan(planId, { includeInactive = false } = {}) {
  const plans = await getMembershipPlans({ includeInactive, includeArchived: true });
  return plans.find((plan) => plan.id === planId) || null;
}

export async function createMembershipCheckout({
  userId,
  planId,
  countryCode = 'US',
  customerEmail = '',
  customerName = 'Member',
}) {
  if (!userId) throw new Error('Authentication required');
  const plan = await getMembershipPlan(planId);
  if (!plan || (!plan.isActive && process.env.NODE_ENV === 'production')) {
    throw new Error(`Unknown plan: ${planId}`);
  }

  const isNigeria = String(countryCode || '').trim().toUpperCase() === 'NG';
  const amount = isNigeria
    ? (plan.price_ngn || Math.round(plan.price_usd * NGN_PER_USD))
    : (plan.price_usd || Math.round((plan.price_ngn || 0) / NGN_PER_USD * 100) / 100);
  const currency = isNigeria ? 'NGN' : 'USD';
  const orderKey = `${userId}_${plan.id}_${Date.now()}`;
  const idempotencyKey = `membership:${userId}:${plan.id}:${Date.now()}:${randomUUID()}`;

  let orderId = null;
  if (supabase) {
    const { data, error } = await supabase
      .from('monetization_orders')
      .insert({
        order_key: orderKey,
        user_id: userId,
        product_type: 'membership',
        product_id: plan.id,
        amount,
        currency,
        status: 'pending',
        idempotency_key: idempotencyKey,
        metadata: { plan },
      })
      .select('id')
      .maybeSingle();
    if (!error) orderId = data?.id || null;
    else if (!isMissingDbFeature(error)) throw error;
  }

  const paymentResp = await createCheckout({
    orderId: orderKey,
    userId,
    planId: plan.id,
    productType: 'membership',
    productId: plan.id,
    countryCode: String(countryCode || 'US').trim().toUpperCase(),
    currency,
    amount,
    productName: plan.name,
    customerEmail,
    customerName,
    metadata: {
      orderId,
      idempotencyKey,
      durationType: plan.durationType,
      durationValue: plan.durationValue,
    },
  });

  if (supabase && orderId) {
    await supabase
      .from('monetization_orders')
      .update({
        provider: paymentResp.provider,
        provider_reference: paymentResp.reference,
        checkout_url: paymentResp.checkoutUrl,
        status: 'checkout_created',
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);
  }

  return { ...paymentResp, orderId, orderKey, plan };
}

export async function isPaymentAlreadyProcessed(reference) {
  if (!reference || !supabase) return false;
  try {
    const [membershipLog, order, coinTx] = await Promise.all([
      supabase.from('membership_billing_logs').select('id').eq('provider_reference', reference).maybeSingle(),
      supabase.from('monetization_orders').select('id,status').eq('provider_reference', reference).maybeSingle(),
      supabase.from('coin_wallet_transactions').select('id').eq('reference', reference).maybeSingle(),
    ]);
    if (membershipLog.error && !isMissingDbFeature(membershipLog.error)) throw membershipLog.error;
    if (order.error && !isMissingDbFeature(order.error)) throw order.error;
    if (coinTx.error && !isMissingDbFeature(coinTx.error)) throw coinTx.error;
    return Boolean(membershipLog.data || coinTx.data || order.data?.status === 'fulfilled');
  } catch (error) {
    if (!isMissingDbFeature(error)) throw error;
    const { data } = await supabase
      .from('user_memberships')
      .select('id')
      .eq('payment_reference', reference)
      .maybeSingle();
    return Boolean(data);
  }
}

export async function activateMembershipFromPayment(userId, planId, {
  reference,
  provider,
  amountPaidUsd,
  currency = 'USD',
  orderKey = null,
  metadata = {},
} = {}) {
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const plan = await getMembershipPlan(planId, { includeInactive: true });
  if (!plan) throw new Error(`Unknown plan: "${planId}"`);

  const expectedAmount = String(currency || 'USD').toUpperCase() === 'NGN' ? plan.price_ngn : plan.price_usd;
  assertPaymentAmountMatches({
    paidAmount: amountPaidUsd,
    expectedAmount,
    currency,
    planId: plan.id,
  });
  const amountForLegacyUsdColumn = amountPaidUsd == null
    ? null
    : (String(currency || 'USD').toUpperCase() === 'NGN' ? money(Number(amountPaidUsd) / NGN_PER_USD) : amountPaidUsd);

  const existingOrder = await findMonetizationOrder({ reference, orderKey });
  if (existingOrder?.status === 'fulfilled') {
    return { duplicate: true, membership: null, plan, coinsAdded: 0 };
  }

  await supabase.from('users').upsert({ id: userId }, { onConflict: 'id' });

  const now = new Date();
  const existing = await getLatestActiveMembershipRow(userId, plan.id);
  const samePlanRenewal = existing?.plan_id === plan.id && existing.status === 'active' && new Date(existing.expires_at) > now;
  const start = samePlanRenewal ? new Date(existing.expires_at) : now;
  const expiresAt = calculateMembershipExpiration(start, plan.durationType, plan.durationValue);
  const graceEndsAt = new Date(expiresAt);
  graceEndsAt.setDate(graceEndsAt.getDate() + GRACE_PERIOD_DAYS);
  const renewalStatus = plan.isRecurring ? 'active' : 'none';

  if (samePlanRenewal) {
    const { data: membership, error } = await supabase
      .from('user_memberships')
      .update({
        expires_at: expiresAt.toISOString(),
        grace_ends_at: graceEndsAt.toISOString(),
        next_billing_at: plan.isRecurring ? expiresAt.toISOString() : null,
        renewal_status: renewalStatus,
        cancel_at_period_end: false,
        payment_reference: reference || existing.payment_reference,
        payment_provider: provider || existing.payment_provider,
        provider_metadata: metadata,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    await syncUserMembershipColumns(userId, plan.id, expiresAt, graceEndsAt);
    await writeMembershipBillingLog({ userId, membership, plan, reference, provider, amountPaidUsd, currency, reason: 'renewal', metadata });
    await markOrderFulfilled(existingOrder, reference, provider);
    return { membership, plan, coinsAdded: 0, expiresAt: expiresAt.toISOString(), graceEndsAt: graceEndsAt.toISOString() };
  }

  await supabase
    .from('user_memberships')
    .update({
      status: 'cancelled',
      renewal_status: 'none',
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: { replacedByPlanId: plan.id },
    })
    .eq('user_id', userId)
    .in('status', ['active', 'grace', 'paused', 'past_due']);

  const { data: membership, error: memErr } = await supabase
    .from('user_memberships')
    .insert({
      user_id: userId,
      plan_id: plan.id,
      coins_received: plan.coinBonus,
      status: 'active',
      renewal_status: renewalStatus,
      payment_reference: reference || null,
      payment_provider: provider || null,
      amount_paid_usd: amountForLegacyUsdColumn,
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      grace_ends_at: graceEndsAt.toISOString(),
      next_billing_at: plan.isRecurring ? expiresAt.toISOString() : null,
      provider_metadata: metadata,
      metadata: {
        durationType: plan.durationType,
        durationValue: plan.durationValue,
        permissions: plan.permissions,
        limits: plan.limits,
      },
    })
    .select()
    .maybeSingle();
  if (memErr) throw memErr;

  await syncUserMembershipColumns(userId, plan.id, expiresAt, graceEndsAt);

  let coinsAdded = 0;
  if (plan.coinBonus > 0) {
    const coinResult = await creditCoins({
      userId,
      amount: plan.coinBonus,
      type: 'bonus',
      reference: reference ? `${reference}:membership_bonus` : null,
      provider,
      idempotencyKey: reference ? `membership_bonus:${reference}` : null,
      sourceType: 'membership_plan',
      sourceId: plan.id,
      metadata: { planId: plan.id, membershipId: membership.id },
    });
    coinsAdded = Number(coinResult.balance != null ? plan.coinBonus : 0);
  }

  await writeMembershipBillingLog({ userId, membership, plan, reference, provider, amountPaidUsd, currency, reason: 'initial_purchase', metadata });
  await writeSubscriptionEvent({ userId, membershipId: membership.id, eventType: 'activated', status: 'active', metadata: { planId: plan.id } });
  await markOrderFulfilled(existingOrder, reference, provider);

  return { membership, plan, coinsAdded, expiresAt: expiresAt.toISOString(), graceEndsAt: graceEndsAt.toISOString() };
}

async function getLatestActiveMembershipRow(userId, planId = null) {
  let query = supabase
    .from('user_memberships')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['active', 'grace', 'paused', 'past_due'])
    .order('expires_at', { ascending: false })
    .limit(1);
  if (planId) query = query.eq('plan_id', planId);
  const { data, error } = await query;
  if (error && !isMissingDbFeature(error)) throw error;
  return data?.[0] || null;
}

async function syncUserMembershipColumns(userId, planId, expiresAt, graceEndsAt) {
  const { error } = await supabase
    .from('users')
    .update({
      active_plan: planId,
      plan_expires_at: expiresAt.toISOString(),
      plan_grace_ends_at: graceEndsAt.toISOString(),
    })
    .eq('id', userId);
  if (error && !isMissingDbFeature(error)) throw error;
}

async function writeMembershipBillingLog({ userId, membership, plan, reference, provider, amountPaidUsd, currency, reason, metadata = {} }) {
  if (!membership?.id) return;
  const fallbackAmount = String(currency || 'USD').toUpperCase() === 'NGN' ? plan.price_ngn : plan.price_usd;
  const { error } = await supabase.from('membership_billing_logs').insert({
    user_id: userId,
    membership_id: membership.id,
    provider,
    provider_reference: reference,
    amount: amountPaidUsd ?? fallbackAmount ?? 0,
    currency,
    status: 'paid',
    billing_reason: reason,
    metadata: { ...metadata, planId: plan.id },
  });
  if (error && !isMissingDbFeature(error)) console.warn('[membership] billing log failed:', error.message || error);
}

async function writeSubscriptionEvent({ userId, membershipId, eventType, status, metadata = {} }) {
  const { error } = await supabase.from('subscription_events').insert({
    user_id: userId,
    membership_id: membershipId,
    event_type: eventType,
    status,
    metadata,
  });
  if (error && !isMissingDbFeature(error)) console.warn('[membership] event log failed:', error.message || error);
}

async function findMonetizationOrder({ reference, orderKey }) {
  if (!supabase || (!reference && !orderKey)) return null;
  try {
    let query = supabase.from('monetization_orders').select('*').limit(1);
    if (reference) query = query.eq('provider_reference', reference);
    else query = query.eq('order_key', orderKey);
    const { data, error } = await query;
    if (error) {
      if (isMissingDbFeature(error)) return null;
      throw error;
    }
    return data?.[0] || null;
  } catch (error) {
    if (isMissingDbFeature(error)) return null;
    throw error;
  }
}

async function markOrderFulfilled(order, reference, provider) {
  if (!order?.id) return;
  await supabase
    .from('monetization_orders')
    .update({
      status: 'fulfilled',
      provider: provider || order.provider,
      provider_reference: reference || order.provider_reference,
      fulfilled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', order.id);
}

export async function getUserMembership(userId) {
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  await supabase.from('users').upsert({ id: userId }, { onConflict: 'id' });

  const now = new Date();
  const [membershipRes, userRes, wallet] = await Promise.all([
    supabase
      .from('user_memberships')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['active', 'grace', 'paused', 'past_due'])
      .order('expires_at', { ascending: false })
      .limit(1),
    supabase
      .from('users')
      .select('id, coin_balance, active_plan, plan_expires_at, plan_grace_ends_at')
      .eq('id', userId)
      .maybeSingle(),
    getCoinWallet(userId).catch(() => null),
  ]);

  if (membershipRes.error && !isMissingDbFeature(membershipRes.error)) throw membershipRes.error;
  if (userRes.error) throw userRes.error;

  let membership = membershipRes.data?.[0] || null;
  let plan = membership?.plan_id || userRes.data?.active_plan || 'basic';
  let expiresAt = membership?.expires_at || userRes.data?.plan_expires_at || null;
  let graceEndsAt = membership?.grace_ends_at || userRes.data?.plan_grace_ends_at || null;
  let planStatus = 'basic';

  if (plan && plan !== 'basic') {
    const expires = expiresAt ? new Date(expiresAt) : null;
    const grace = graceEndsAt ? new Date(graceEndsAt) : null;
    if (membership?.status === 'paused') {
      planStatus = 'paused';
    } else if (expires && now < expires) {
      planStatus = 'active';
    } else if (grace && now < grace) {
      planStatus = 'grace';
      if (membership?.status === 'active') {
        await updateMembershipStatus(membership, 'grace', { eventType: 'entered_grace' });
      }
    } else {
      planStatus = 'expired';
      await expireMembershipForUser(userId, membership);
      plan = 'basic';
      expiresAt = null;
      graceEndsAt = null;
    }
  }

  const expires = expiresAt ? new Date(expiresAt) : null;
  const grace = graceEndsAt ? new Date(graceEndsAt) : null;
  const daysLeft = expires && ['active', 'paused'].includes(planStatus)
    ? Math.max(0, Math.ceil((expires - now) / 86_400_000))
    : 0;
  const graceDaysLeft = grace && planStatus === 'grace'
    ? Math.max(0, Math.ceil((grace - now) / 86_400_000))
    : 0;

  return {
    userId,
    membershipId: membership?.id || null,
    plan,
    planId: plan,
    planStatus,
    status: planStatus,
    renewalStatus: membership?.renewal_status || 'none',
    cancelAtPeriodEnd: membership?.cancel_at_period_end === true,
    pausedAt: membership?.paused_at || null,
    cancelledAt: membership?.cancelled_at || null,
    nextBillingAt: membership?.next_billing_at || null,
    coinBalance: wallet?.balance ?? Number(userRes.data?.coin_balance ?? 0),
    expiresAt,
    graceEndsAt,
    daysLeft,
    graceDaysLeft,
    membership,
  };
}

async function updateMembershipStatus(membership, status, { eventType = status } = {}) {
  const { error } = await supabase
    .from('user_memberships')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', membership.id);
  if (error && !isMissingDbFeature(error)) throw error;
  await writeSubscriptionEvent({ userId: membership.user_id, membershipId: membership.id, eventType, status });
}

export async function expireMembershipForUser(userId, membership = null) {
  const target = membership || await getLatestActiveMembershipRow(userId);
  if (target) {
    await supabase
      .from('user_memberships')
      .update({
        status: 'expired',
        renewal_status: 'none',
        updated_at: new Date().toISOString(),
      })
      .eq('id', target.id);
    await writeSubscriptionEvent({ userId, membershipId: target.id, eventType: 'expired', status: 'expired' });
  }

  await supabase
    .from('users')
    .update({
      active_plan: 'basic',
      plan_expires_at: null,
      plan_grace_ends_at: null,
    })
    .eq('id', userId);
}

export async function cancelMembership(userId) {
  const membership = await getLatestActiveMembershipRow(userId);
  if (!membership) return { cancelled: false, reason: 'No active membership.' };
  const update = {
    cancel_at_period_end: true,
    renewal_status: 'cancel_at_period_end',
    cancelled_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('user_memberships').update(update).eq('id', membership.id).select().maybeSingle();
  if (error) throw error;
  await writeSubscriptionEvent({ userId, membershipId: membership.id, eventType: 'cancel_scheduled', status: data.status });
  return { cancelled: true, membership: data };
}

export async function pauseMembership(userId) {
  const membership = await getLatestActiveMembershipRow(userId);
  if (!membership) return { paused: false, reason: 'No active membership.' };
  const { data, error } = await supabase
    .from('user_memberships')
    .update({
      status: 'paused',
      renewal_status: 'paused',
      paused_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', membership.id)
    .select()
    .maybeSingle();
  if (error) throw error;
  await writeSubscriptionEvent({ userId, membershipId: membership.id, eventType: 'paused', status: 'paused' });
  return { paused: true, membership: data };
}

export async function resumeMembership(userId) {
  const membership = await getLatestActiveMembershipRow(userId);
  if (!membership) return { resumed: false, reason: 'No paused membership.' };
  const { data, error } = await supabase
    .from('user_memberships')
    .update({
      status: 'active',
      renewal_status: membership.next_billing_at ? 'active' : 'none',
      paused_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', membership.id)
    .select()
    .maybeSingle();
  if (error) throw error;
  await writeSubscriptionEvent({ userId, membershipId: membership.id, eventType: 'resumed', status: 'active' });
  return { resumed: true, membership: data };
}

export async function listMembershipBilling(userId, { page = 1, limit = 25 } = {}) {
  const from = (Math.max(1, Number(page) || 1) - 1) * Math.min(100, Math.max(1, Number(limit) || 25));
  const to = from + Math.min(100, Math.max(1, Number(limit) || 25)) - 1;
  const { data, error, count } = await supabase
    .from('membership_billing_logs')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) {
    if (isMissingDbFeature(error)) return { billing: [], total: 0, page, limit };
    throw error;
  }
  return { billing: data || [], total: count || 0, page: Number(page) || 1, limit: Math.min(100, Math.max(1, Number(limit) || 25)) };
}

export async function expireDueMemberships({ limit = 500 } = {}) {
  if (!supabase) return { expired: 0 };
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('user_memberships')
    .select('*')
    .in('status', ['active', 'grace', 'past_due'])
    .lt('grace_ends_at', now)
    .limit(limit);
  if (error) {
    if (isMissingDbFeature(error)) return { expired: 0 };
    throw error;
  }
  let expired = 0;
  for (const membership of data || []) {
    await expireMembershipForUser(membership.user_id, membership);
    expired += 1;
  }
  return { expired };
}

export async function createRenewalReminderEvents({ days = [7, 3, 1], limit = 500 } = {}) {
  if (!supabase) return { reminders: 0 };
  const now = new Date();
  const maxDays = Math.max(...days);
  const until = new Date(now.getTime() + maxDays * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('user_memberships')
    .select('*')
    .eq('status', 'active')
    .gt('expires_at', now.toISOString())
    .lte('expires_at', until)
    .limit(limit);
  if (error) {
    if (isMissingDbFeature(error)) return { reminders: 0 };
    throw error;
  }
  let reminders = 0;
  for (const membership of data || []) {
    const remainingDays = Math.ceil((new Date(membership.expires_at) - now) / 86_400_000);
    if (!days.includes(remainingDays)) continue;
    const eventKey = `renewal_reminder_${remainingDays}d`;
    const { data: existing } = await supabase
      .from('subscription_events')
      .select('id')
      .eq('membership_id', membership.id)
      .eq('event_type', eventKey)
      .maybeSingle();
    if (existing) continue;
    await writeSubscriptionEvent({
      userId: membership.user_id,
      membershipId: membership.id,
      eventType: eventKey,
      status: membership.status,
      metadata: { daysLeft: remainingDays },
    });
    reminders += 1;
  }
  return { reminders };
}

export async function getMembershipAnalytics() {
  if (!supabase) return emptyMembershipAnalytics();
  try {
    const [membershipsRes, billingRes, plans] = await Promise.all([
      supabase.from('user_memberships').select('status,plan_id,expires_at,created_at'),
      supabase.from('membership_billing_logs').select('amount,status,currency,created_at'),
      getMembershipPlans({ includeInactive: true, includeArchived: true }),
    ]);
    if (membershipsRes.error && !isMissingDbFeature(membershipsRes.error)) throw membershipsRes.error;
    if (billingRes.error && !isMissingDbFeature(billingRes.error)) throw billingRes.error;
    const memberships = membershipsRes.data || [];
    const billing = billingRes.data || [];
    const activeSubscribers = memberships.filter((row) => ['active', 'grace', 'paused'].includes(row.status)).length;
    const revenueUsd = money(billing.filter((row) => row.status === 'paid').reduce((sum, row) => sum + Number(row.amount || 0), 0));
    return {
      plans: plans.length,
      activeSubscribers,
      expiredSubscribers: memberships.filter((row) => row.status === 'expired').length,
      cancelledSubscribers: memberships.filter((row) => row.status === 'cancelled').length,
      mrrUsd: revenueUsd,
      revenueUsd,
      churnRate: memberships.length ? Math.round((memberships.filter((row) => ['cancelled', 'expired'].includes(row.status)).length / memberships.length) * 10000) / 100 : 0,
    };
  } catch (error) {
    if (isMissingDbFeature(error)) return emptyMembershipAnalytics();
    throw error;
  }
}

function emptyMembershipAnalytics() {
  return {
    plans: 0,
    activeSubscribers: 0,
    expiredSubscribers: 0,
    cancelledSubscribers: 0,
    mrrUsd: 0,
    revenueUsd: 0,
    churnRate: 0,
  };
}

export function planPayloadFromAdmin(body = {}, { existing = null } = {}) {
  const duration = body.durationType || body.duration_type
    ? { durationType: normalizeDurationType(body.durationType || body.duration_type), durationValue: Math.max(1, Number(body.durationValue || body.duration_value || 1)) }
    : parseDurationInput(body.duration || body.duration_label || existing?.duration_label || existing?.duration_days, existing?.duration_days || 30);
  const currency = String(body.currency || existing?.currency || 'USD').toUpperCase();
  const price = body.price ?? (currency === 'NGN' ? existing?.price_ngn : existing?.price_usd) ?? 0;

  return {
    name: String(body.title ?? body.name ?? existing?.name ?? '').trim(),
    description: String(body.description ?? existing?.description ?? '').trim(),
    price_usd: currency === 'NGN' ? Number(existing?.price_usd || 0) : Number(price || 0),
    price_ngn: currency === 'NGN' ? Number(price || 0) : Number(body.priceNgn ?? body.price_ngn ?? existing?.price_ngn ?? 0),
    currency,
    duration_label: body.duration || body.durationLabel || durationLabel(duration.durationType, duration.durationValue),
    duration_type: duration.durationType,
    duration_value: duration.durationValue,
    duration_days: duration.durationType === 'days' ? duration.durationValue : Number(existing?.duration_days || 30),
    features: Array.isArray(body.features)
      ? body.features
      : String(body.features || '')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean),
    image_url: body.image ?? body.imageUrl ?? existing?.image_url ?? null,
    badge: body.badge ?? existing?.badge ?? null,
    permissions: body.permissions || body.accessPermissions || existing?.permissions || {},
    limits: body.limits || existing?.limits || {},
    creator_benefits: body.creatorBenefits || body.creator_benefits || existing?.creator_benefits || {},
    ai_access: body.aiAccess || body.ai_access || existing?.ai_access || {},
    visibility_priority: Number(body.visibilityPriority ?? body.visibility_priority ?? existing?.visibility_priority ?? 0),
    coin_bonus: Number(body.coinBonus ?? body.coin_bonus ?? body.coins ?? existing?.coin_bonus ?? 0),
    is_recurring: body.isRecurring ?? body.is_recurring ?? existing?.is_recurring ?? false,
    is_active: body.isActive ?? body.is_active ?? existing?.is_active ?? true,
    sort_order: Number(body.sortOrder ?? body.sort_order ?? existing?.sort_order ?? 0),
    metadata: body.metadata || existing?.metadata || {},
    updated_at: new Date().toISOString(),
  };
}
