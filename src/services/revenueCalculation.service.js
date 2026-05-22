import { supabase } from '../config/supabase.js';
import { getNumberSetting, getPlatformSettingsMap, invalidatePlatformSettingsCache } from './platformSettings.service.js';

const CENTS = 100;

export function money(value) {
  return Math.round((Number(value) || 0) * CENTS) / CENTS;
}

export function isMissingDbFeature(error) {
  return (
    error?.code === '42P01' ||
    error?.code === 'PGRST200' ||
    error?.code === '42703' ||
    error?.code === 'PGRST204'
  );
}

function clampPercent(n) {
  return Math.min(100, Math.max(0, money(n)));
}

export function parseCommissionRules(raw) {
  if (!raw) return { categories: {}, creators: {} };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      categories: parsed?.categories && typeof parsed.categories === 'object' ? parsed.categories : {},
      creators: parsed?.creators && typeof parsed.creators === 'object' ? parsed.creators : {},
    };
  } catch {
    return { categories: {}, creators: {} };
  }
}

export async function getCommissionRates(options = {}) {
  const { creatorId = null, category = null, source = null } = options;
  const map = await getPlatformSettingsMap();
  let platformPercent = Number(map.platform_fee_percent);
  if (!Number.isFinite(platformPercent)) platformPercent = 30;
  let creatorPercent = Number(map.creator_revenue_share_percent);
  if (!Number.isFinite(creatorPercent)) creatorPercent = 100 - platformPercent;

  if (source === 'live_gift') {
    const giftPlatform = Number(map.live_gift_platform_percent);
    const giftCreator = Number(map.live_gift_creator_percent);
    if (Number.isFinite(giftPlatform)) platformPercent = giftPlatform;
    if (Number.isFinite(giftCreator)) creatorPercent = giftCreator;
  } else if (source === 'subscription' || source === 'membership') {
    const subPlatform = Number(map.subscription_platform_fee_percent);
    if (Number.isFinite(subPlatform)) platformPercent = subPlatform;
    creatorPercent = 100 - platformPercent;
  } else if (source === 'purchase' || source === 'video_purchase' || source === 'premium_video') {
    const vpCreator = Number(map.video_purchase_creator_percent);
    const vpPlatform = Number(map.video_purchase_platform_percent);
    if (Number.isFinite(vpCreator)) creatorPercent = vpCreator;
    if (Number.isFinite(vpPlatform)) platformPercent = vpPlatform;
    else if (Number.isFinite(vpCreator)) platformPercent = 100 - vpCreator;
  }

  const rules = parseCommissionRules(map.revenue_commission_rules);
  if (category && rules.categories[category]) {
    const rule = rules.categories[category];
    if (rule.platformPercent != null) platformPercent = Number(rule.platformPercent);
    if (rule.creatorPercent != null) creatorPercent = Number(rule.creatorPercent);
  }
  if (creatorId && rules.creators[creatorId]) {
    const rule = rules.creators[creatorId];
    if (rule.platformPercent != null) platformPercent = Number(rule.platformPercent);
    if (rule.creatorPercent != null) creatorPercent = Number(rule.creatorPercent);
  }

  platformPercent = clampPercent(platformPercent);
  creatorPercent = clampPercent(creatorPercent);
  if (platformPercent + creatorPercent !== 100) {
    creatorPercent = clampPercent(100 - platformPercent);
  }

  return {
    platformPercent,
    creatorPercent,
    withdrawalFeePercent: clampPercent(Number(map.withdrawal_fee_percent) || 0),
    taxPercent: clampPercent(Number(map.tax_percent) || 0),
    processingFeePercent: clampPercent(Number(map.processing_fee_percent) || 0),
  };
}

export function splitGrossAmount(grossUsd, platformPercent) {
  const gross = money(Math.max(0, grossUsd));
  const platformFee = money(gross * (clampPercent(platformPercent) / 100));
  const creatorEarnings = money(Math.max(0, gross - platformFee));
  return { grossUsd: gross, platformFeeUsd: platformFee, creatorEarningsUsd: creatorEarnings };
}

export function grossFromCreatorShare(creatorUsd, creatorPercent) {
  const share = clampPercent(creatorPercent);
  if (share <= 0) return money(creatorUsd);
  return money(Math.max(0, creatorUsd) / (share / 100));
}

export function resolveRange(query = {}, timezone = 'UTC') {
  const range = String(query.range || '30d').toLowerCase();
  const now = new Date();
  let from;
  let to = query.to ? new Date(query.to) : now;
  if (Number.isNaN(to.getTime())) to = now;

  if (query.from) {
    from = new Date(query.from);
  } else if (range === 'today') {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    from = new Date(`${y}-${m}-${d}T00:00:00`);
  } else if (range === '7d') {
    from = new Date(now.getTime() - 7 * 864e5);
  } else if (range === '30d') {
    from = new Date(now.getTime() - 30 * 864e5);
  } else if (range === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (range === 'year') {
    from = new Date(now.getFullYear(), 0, 1);
  } else {
    from = new Date(now.getTime() - 30 * 864e5);
  }

  if (Number.isNaN(from.getTime())) from = new Date(now.getTime() - 30 * 864e5);
  const spanMs = Math.max(864e5, to.getTime() - from.getTime());
  const prevTo = new Date(from.getTime());
  const prevFrom = new Date(from.getTime() - spanMs);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  return { from, to, prevFrom, prevTo, range, monthStart, yearStart, timezone };
}

export function inRange(dateValue, from, to) {
  if (!dateValue) return false;
  const ts = new Date(dateValue).getTime();
  return ts >= from.getTime() && ts <= to.getTime();
}

export function growthPct(current, previous) {
  if (previous == null || previous === 0) return current > 0 ? 100 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function fetchEarningsRows(creatorId = null) {
  if (!supabase) return [];
  let query = supabase
    .from('creator_earnings')
    .select('id, creator_id, amount_usd, gross_usd, platform_fee_usd, source, created_at, reference_id');
  if (creatorId) query = query.eq('creator_id', creatorId);
  const { data, error } = await query;
  if (error && isMissingDbFeature(error)) {
    let fallback = supabase.from('creator_earnings').select('creator_id, amount_usd, source, created_at');
    if (creatorId) fallback = fallback.eq('creator_id', creatorId);
    const res = await fallback;
    if (res.error && !isMissingDbFeature(res.error)) throw res.error;
    return res.data || [];
  }
  if (error) throw error;
  return data || [];
}

export async function sumCreatorEarnings(creatorId, options = {}) {
  const rates = await getCommissionRates({ creatorId, ...options });
  const rows = await fetchEarningsRows(creatorId);
  const seenRefs = new Set();
  let lifetimeCreator = 0;
  let lifetimeGross = 0;
  let lifetimePlatform = 0;

  for (const row of rows) {
    if (row.reference_id) {
      if (seenRefs.has(row.reference_id)) continue;
      seenRefs.add(row.reference_id);
    }
    const creatorAmt = money(row.amount_usd);
    const gross = row.gross_usd != null ? money(row.gross_usd) : grossFromCreatorShare(creatorAmt, rates.creatorPercent);
    const platformFee = row.platform_fee_usd != null ? money(row.platform_fee_usd) : money(gross - creatorAmt);
    lifetimeCreator += creatorAmt;
    lifetimeGross += gross;
    lifetimePlatform += platformFee;
  }

  return {
    lifetimeCreatorEarnings: money(lifetimeCreator),
    lifetimeGrossRevenue: money(lifetimeGross),
    lifetimePlatformFees: money(lifetimePlatform),
    transactionCount: seenRefs.size || rows.length,
    rates,
  };
}

const COMPLETED_PAYOUT = ['paid', 'completed'];
const COMMITTED_PAYOUT = ['pending', 'approved', 'processing', 'paid', 'completed'];

export async function getCreatorWalletBalance(creatorId) {
  const { lifetimeCreatorEarnings } = await sumCreatorEarnings(creatorId);
  if (!supabase) {
    return { available: 0, totalEarnings: 0, committed: 0, pendingWithdrawals: 0 };
  }

  const { data: payouts, error } = await supabase
    .from('creator_payout_requests')
    .select('amount_usd, status')
    .eq('creator_id', creatorId);
  if (error && !isMissingDbFeature(error)) throw error;

  const committed = money(
    (payouts || [])
      .filter((r) => COMMITTED_PAYOUT.includes(r.status))
      .reduce((s, r) => s + Number(r.amount_usd || 0), 0),
  );
  const pendingWithdrawals = money(
    (payouts || [])
      .filter((r) => ['pending', 'approved', 'processing'].includes(r.status))
      .reduce((s, r) => s + Number(r.amount_usd || 0), 0),
  );

  return {
    totalEarnings: lifetimeCreatorEarnings,
    committed,
    pendingWithdrawals,
    available: money(Math.max(0, lifetimeCreatorEarnings - committed)),
    paidOut: money(
      (payouts || [])
        .filter((r) => COMPLETED_PAYOUT.includes(r.status))
        .reduce((s, r) => s + Number(r.amount_usd || 0), 0),
    ),
  };
}

export async function getUserEarningsSummary(userId) {
  const summary = await sumCreatorEarnings(userId);
  const wallet = await getCreatorWalletBalance(userId);
  return {
    userId,
    earnings: summary.lifetimeCreatorEarnings,
    grossRevenue: summary.lifetimeGrossRevenue,
    platformFees: summary.lifetimePlatformFees,
    availableBalance: wallet.available,
    pendingWithdrawals: wallet.pendingWithdrawals,
    paidOut: wallet.paidOut,
    updatedAt: new Date().toISOString(),
  };
}

export async function recordCreatorEarning({
  creatorId,
  grossUsd,
  source = 'purchase',
  referenceId = null,
  category = null,
  metadata = {},
}) {
  if (!supabase || !creatorId) throw new Error('Cannot record earnings without database.');
  const rates = await getCommissionRates({ creatorId, category, source });
  const split = splitGrossAmount(grossUsd, rates.platformPercent);

  const row = {
    creator_id: creatorId,
    amount_usd: split.creatorEarningsUsd,
    gross_usd: split.grossUsd,
    platform_fee_usd: split.platformFeeUsd,
    source,
    reference_id: referenceId || null,
    metadata,
    created_at: new Date().toISOString(),
  };

  if (referenceId) {
    const { data: existing } = await supabase
      .from('creator_earnings')
      .select('id')
      .eq('reference_id', referenceId)
      .maybeSingle();
    if (existing?.id) return { duplicate: true, row: existing };
  }

  const { data, error } = await supabase.from('creator_earnings').insert(row).select().maybeSingle();
  if (error && isMissingDbFeature(error)) {
    const fallback = {
      creator_id: creatorId,
      amount_usd: split.creatorEarningsUsd,
      source,
      created_at: row.created_at,
    };
    const res = await supabase.from('creator_earnings').insert(fallback).select().maybeSingle();
    if (res.error) throw res.error;
    return { duplicate: false, row: res.data, split };
  }
  if (error) throw error;
  return { duplicate: false, row: data, split };
}

export function invalidateRevenueCache() {
  invalidatePlatformSettingsCache();
}
