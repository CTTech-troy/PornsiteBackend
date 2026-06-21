import { supabase } from '../config/supabase.js';
import { getCommissionRates, grossFromCreatorShare, money, growthPct as calcGrowth, inRange as dateInRange, resolveRange as calcResolveRange } from './revenueCalculation.service.js';

const COMPLETED = ['paid', 'completed'];
const ACTIVE = ['pending', 'approved', 'processing'];

function isMissingDbFeature(error) {
  return error?.code === '42P01' || error?.code === 'PGRST200' || error?.code === '42703';
}

const growthPct = calcGrowth;
const inRange = dateInRange;

function sumByStatus(rows, statuses) {
  return money(
    (rows || [])
      .filter((r) => statuses.includes(r.status))
      .reduce((sum, r) => sum + Number(r.amount_usd || 0), 0),
  );
}

export async function getPayoutMetrics(query = {}) {
  if (!supabase) return null;

  const { from, to, prevFrom, prevTo } = calcResolveRange(query);

  const rates = await getCommissionRates();

  const [payoutsRes, earningsRes] = await Promise.all([
    supabase.from('creator_payout_requests').select('amount_usd,status,requested_at,processed_at,paid_at,completed_at,risk_score,creator_id'),
    supabase.from('creator_earnings').select('amount_usd,gross_usd,platform_fee_usd,creator_id,created_at,reference_id'),
  ]);

  if (payoutsRes.error && !isMissingDbFeature(payoutsRes.error)) throw payoutsRes.error;

  const payouts = payoutsRes.data || [];
  const earnings = earningsRes.error ? [] : (earningsRes.data || []);

  const periodPayouts = payouts.filter((r) => inRange(r.requested_at, from, to));
  const prevPayouts = payouts.filter((r) => inRange(r.requested_at, prevFrom, prevTo));

  const seenRefs = new Set();
  let periodEarningsGross = 0;
  let prevEarningsGross = 0;
  let periodPlatformFromEarnings = 0;

  for (const row of earnings) {
    if (row.reference_id) {
      if (seenRefs.has(row.reference_id)) continue;
      seenRefs.add(row.reference_id);
    }
    const creatorAmt = money(row.amount_usd);
    const gross = row.gross_usd != null ? money(row.gross_usd) : grossFromCreatorShare(creatorAmt, rates.creatorPercent);
    const platformFee = row.platform_fee_usd != null ? money(row.platform_fee_usd) : money(gross - creatorAmt);
    if (inRange(row.created_at, from, to)) {
      periodEarningsGross += gross;
      periodPlatformFromEarnings += platformFee;
    } else if (inRange(row.created_at, prevFrom, prevTo)) {
      prevEarningsGross += gross;
    }
  }

  const periodRevenue = money(periodEarningsGross);
  const prevRevenue = money(prevEarningsGross);

  const completedInPeriod = payouts.filter((r) => {
    const doneAt = r.completed_at || r.paid_at || r.processed_at;
    return COMPLETED.includes(r.status) && inRange(doneAt, from, to);
  });

  const prevCompleted = payouts.filter((r) => {
    const doneAt = r.completed_at || r.paid_at || r.processed_at;
    return COMPLETED.includes(r.status) && inRange(doneAt, prevFrom, prevTo);
  });

  const durations = completedInPeriod
    .map((r) => {
      const start = new Date(r.requested_at).getTime();
      const end = new Date(r.completed_at || r.paid_at || r.processed_at).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 36e5 : null;
    })
    .filter((v) => v != null);

  const daily = new Map();
  const statusVolume = {
    pending: 0,
    approved: 0,
    processing: 0,
    paid: 0,
    rejected: 0,
    failed: 0,
  };

  for (const row of periodPayouts) {
    const amount = Number(row.amount_usd || 0);
    const day = String(row.requested_at || '').slice(0, 10);
    if (day) daily.set(day, (daily.get(day) || 0) + amount);
    if (statusVolume[row.status] != null) statusVolume[row.status] += amount;
    else if (COMPLETED.includes(row.status)) statusVolume.paid += amount;
  }

  const totalEarnings = money(earnings.reduce((s, r) => s + Number(r.amount_usd || 0), 0));
  const committed = money(payouts.filter((r) => [...ACTIVE, ...COMPLETED].includes(r.status)).reduce((s, r) => s + Number(r.amount_usd || 0), 0));
  const totalWalletBalances = money(Math.max(0, totalEarnings - committed));

  const highRiskBalances = money(
    payouts
      .filter((r) => Number(r.risk_score || 0) >= 50 && ACTIVE.includes(r.status))
      .reduce((s, r) => s + Number(r.amount_usd || 0), 0),
  );

  const paidTotal = sumByStatus(payouts, COMPLETED);
  const rejectedTotal = sumByStatus(payouts, ['rejected']);
  const pendingTotal = sumByStatus(payouts, ['pending']);
  const approvedTotal = sumByStatus(payouts, ['approved']);
  const processingTotal = sumByStatus(payouts, ['processing']);
  const failedTotal = sumByStatus(payouts, ['failed']);

  const completedAmount = money(completedInPeriod.reduce((s, r) => s + Number(r.amount_usd || 0), 0));
  const avgPayout = completedInPeriod.length ? money(completedAmount / completedInPeriod.length) : null;

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const completedThisMonth = money(
    payouts
      .filter((r) => {
        if (!COMPLETED.includes(r.status)) return false;
        const ts = r.completed_at || r.paid_at;
        return ts && new Date(ts) >= monthStart;
      })
      .reduce((s, r) => s + Number(r.amount_usd || 0), 0),
  );

  const platformFees = money(periodPlatformFromEarnings);
  const netPayoutTotals = money(completedAmount);

  return {
    range: query.range || '30d',
    from: from.toISOString(),
    to: to.toISOString(),
    totalRevenue: money(periodRevenue),
    totalRevenueGrowth: growthPct(periodRevenue, prevRevenue),
    pendingPayouts: pendingTotal,
    paidWithdrawals: paidTotal,
    rejectedWithdrawals: rejectedTotal,
    pendingAmount: pendingTotal,
    approvedAmount: approvedTotal,
    processingAmount: processingTotal,
    failedAmount: failedTotal,
    totalWalletBalances,
    avgPayout,
    avgProcessingHours: durations.length
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : null,
    completedThisMonth,
    highRiskBalances,
    platformFees,
    netPayoutTotals,
    highRiskCount: payouts.filter((r) => Number(r.risk_score || 0) >= 50).length,
    completedPayouts: completedAmount,
    completedPayoutsGrowth: growthPct(
      completedAmount,
      prevCompleted.reduce((s, r) => s + Number(r.amount_usd || 0), 0),
    ),
    daily: Array.from(daily.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, amount]) => ({ date, amount: money(amount) })),
    statusVolume: Object.fromEntries(
      Object.entries(statusVolume).map(([k, v]) => [k, money(v)]),
    ),
    revenueDaily: (() => {
      const map = new Map();
      for (const row of earnings) {
        if (!inRange(row.created_at, from, to)) continue;
        const day = String(row.created_at || '').slice(0, 10);
        if (!day) continue;
        const creatorAmt = money(row.amount_usd);
        const gross = row.gross_usd != null ? money(row.gross_usd) : grossFromCreatorShare(creatorAmt, rates.creatorPercent);
        map.set(day, money((map.get(day) || 0) + gross));
      }
      return map;
    })(),
    totalCreatorEarningsPeriod: money(
      earnings
        .filter((r) => inRange(r.created_at, from, to))
        .reduce((s, r) => s + Number(r.amount_usd || 0), 0),
    ),
  };
}

export async function getPayoutAnalyticsWithRange(query = {}) {
  const metrics = await getPayoutMetrics(query);
  if (!metrics) return {};

  return {
    totalPayouts: metrics.completedPayouts + metrics.pendingAmount + metrics.processingAmount,
    pendingPayouts: metrics.pendingAmount,
    approvedPayouts: metrics.approvedAmount,
    processingPayouts: metrics.processingAmount,
    completedPayouts: metrics.paidWithdrawals,
    failedPayouts: metrics.failedAmount,
    rejectedPayouts: metrics.rejectedWithdrawals,
    highRiskCount: metrics.highRiskCount,
    completedThisMonth: metrics.completedThisMonth,
    avgProcessingHours: metrics.avgProcessingHours ?? 0,
    daily: metrics.daily,
    ...metrics,
  };
}
