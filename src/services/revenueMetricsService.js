import { supabase } from '../config/supabase.js';
import { getStringSetting } from './platformSettings.service.js';
import {
  getCommissionRates,
  grossFromCreatorShare,
  growthPct,
  inRange,
  isMissingDbFeature,
  money,
  resolveRange,
  getUserEarningsSummary,
} from './revenueCalculation.service.js';
import { getPayoutMetrics } from './payoutMetricsService.js';
import { getAdRewardAnalytics } from './creatorAdReward.service.js';
import { filterProductionRecords } from '../utils/testDataFilter.js';

const COMPLETED_PAYOUT = ['paid', 'completed'];
const NGN_PER_USD = Number(process.env.NGN_PER_USD || 1600);
const SUCCESSFUL_PAYMENT_STATUSES = ['success', 'successful', 'fulfilled', 'paid', 'completed', 'complete', 'verified'];

function bucketDaily(rows, dateField, amountField, from, to) {
  const map = new Map();
  for (const row of rows) {
    if (!inRange(row[dateField], from, to)) continue;
    const day = String(row[dateField] || '').slice(0, 10);
    if (!day) continue;
    map.set(day, money((map.get(day) || 0) + Number(row[amountField] || 0)));
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, amount]) => ({ date, amount }));
}

function bucketWeekly(daily) {
  const map = new Map();
  for (const { date, amount } of daily) {
    const d = new Date(`${date}T12:00:00Z`);
    const weekStart = new Date(d);
    weekStart.setUTCDate(d.getUTCDate() - d.getUTCDay());
    const key = weekStart.toISOString().slice(0, 10);
    map.set(key, money((map.get(key) || 0) + amount));
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, amount]) => ({ weekStart, amount }));
}

function bucketMonthly(daily) {
  const map = new Map();
  for (const { date, amount } of daily) {
    const key = date.slice(0, 7);
    map.set(key, money((map.get(key) || 0) + amount));
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, amount }));
}

async function loadRevenueSources() {
  if (!supabase) {
    return { earnings: [], coinPayments: [], payouts: [], transactions: [], payments: [] };
  }

  const [earningsRes, coinPaymentsRes, payoutsRes, transactionsRes] = await Promise.all([
    supabase.from('creator_earnings').select('creator_id, amount_usd, gross_usd, platform_fee_usd, source, created_at, reference_id'),
    supabase.from('payment_intents').select('id,user_id,product_type,product_id,amount,currency,status,provider,provider_reference,intent_key,metadata,product_snapshot,created_at,fulfilled_at'),
    supabase.from('creator_payout_requests').select('creator_id, amount_usd, status, requested_at, completed_at, paid_at'),
    supabase.from('transactions').select('owner_id, type, amount, platform_fee, creator_earnings, created_at').limit(5000),
  ]);

  return {
    earnings: earningsRes.error && isMissingDbFeature(earningsRes.error) ? [] : filterProductionRecords(earningsRes.data || []),
    coinPayments: coinPaymentsRes.error && isMissingDbFeature(coinPaymentsRes.error) ? [] : filterProductionRecords(coinPaymentsRes.data || []),
    payouts: payoutsRes.error && isMissingDbFeature(payoutsRes.error) ? [] : filterProductionRecords(payoutsRes.data || []),
    transactions: transactionsRes.error && isMissingDbFeature(transactionsRes.error) ? [] : filterProductionRecords(transactionsRes.data || []),
    payments: [],
  };
}

export async function getCompanyRevenueMetrics(query = {}) {
  const timezone = await getStringSetting('timezone', 'UTC');
  const { from, to, prevFrom, prevTo, range, monthStart, yearStart } = resolveRange(query, timezone);
  const rates = await getCommissionRates();

  const payoutMetrics = (await getPayoutMetrics(query)) || {};
  const sources = await loadRevenueSources();

  const seenEarningRefs = new Set();
  let periodCreatorEarnings = 0;
  let periodPlatformFromEarnings = 0;
  let periodGrossFromEarnings = 0;
  let coinPurchaseRevenue = 0;
  let videoPurchaseRevenue = 0;
  let tipRevenue = 0;
  let prevCreatorEarnings = 0;
  let prevPlatformFromEarnings = 0;
  let prevCoinPurchaseRevenue = 0;

  const creatorTotals = new Map();
  const payerTotals = new Map();

  for (const row of sources.earnings) {
    if (row.reference_id) {
      if (seenEarningRefs.has(row.reference_id)) continue;
      seenEarningRefs.add(row.reference_id);
    }
    const src = String(row.source || 'other');
    if (/member|subscr/i.test(src)) continue;

    const creatorAmt = money(row.amount_usd);
    const gross = row.gross_usd != null ? money(row.gross_usd) : grossFromCreatorShare(creatorAmt, rates.creatorPercent);
    const platformFee = row.platform_fee_usd != null ? money(row.platform_fee_usd) : money(gross - creatorAmt);

    if (inRange(row.created_at, from, to)) {
      periodCreatorEarnings += creatorAmt;
      periodPlatformFromEarnings += platformFee;
      periodGrossFromEarnings += gross;
      if (src.includes('video') || src === 'purchase') videoPurchaseRevenue += gross;
      else if (src.includes('gift') || src.includes('tip') || src === 'live_gift') tipRevenue += gross;
    } else if (inRange(row.created_at, prevFrom, prevTo)) {
      prevCreatorEarnings += creatorAmt;
      prevPlatformFromEarnings += platformFee;
    }

    if (row.creator_id) {
      creatorTotals.set(row.creator_id, money((creatorTotals.get(row.creator_id) || 0) + creatorAmt));
    }
  }

  for (const payment of sources.coinPayments) {
    const productType = String(payment.product_type || '').toLowerCase();
    if (!/coin|token/.test(productType)) continue;
    if (!SUCCESSFUL_PAYMENT_STATUSES.includes(String(payment.status || '').toLowerCase())) continue;
    const gross = String(payment.currency || 'USD').toUpperCase() === 'NGN'
      ? money(Number(payment.amount || 0) / NGN_PER_USD)
      : money(payment.amount);
    const paidAt = payment.fulfilled_at || payment.created_at;
    if (inRange(paidAt, from, to)) {
      coinPurchaseRevenue += gross;
      periodGrossFromEarnings += gross;
      periodPlatformFromEarnings += gross;
    } else if (inRange(paidAt, prevFrom, prevTo)) {
      prevCoinPurchaseRevenue += gross;
    }
    if (payment.user_id) {
      payerTotals.set(payment.user_id, money((payerTotals.get(payment.user_id) || 0) + gross));
    }
  }

  for (const p of sources.payouts) {
    const doneAt = p.completed_at || p.paid_at;
    if (COMPLETED_PAYOUT.includes(p.status) && inRange(doneAt || p.requested_at, from, to)) {
      /* counted in payoutMetrics */
    }
  }

  const grossRevenue = money(periodGrossFromEarnings);
  const prevGross = money(prevCoinPurchaseRevenue + prevCreatorEarnings + prevPlatformFromEarnings);

  let revenueThisMonth = 0;
  let revenueThisYear = 0;

  for (const e of sources.earnings) {
    const src = String(e.source || '');
    if (/member|subscr/i.test(src)) continue;
    if (e.created_at && new Date(e.created_at) >= monthStart) {
      const g = e.gross_usd != null ? money(e.gross_usd) : grossFromCreatorShare(money(e.amount_usd), rates.creatorPercent);
      revenueThisMonth += g;
    }
    if (e.created_at && new Date(e.created_at) >= yearStart) {
      const g = e.gross_usd != null ? money(e.gross_usd) : grossFromCreatorShare(money(e.amount_usd), rates.creatorPercent);
      revenueThisYear += g;
    }
  }
  for (const payment of sources.coinPayments) {
    const productType = String(payment.product_type || '').toLowerCase();
    if (!/coin|token/.test(productType)) continue;
    if (!SUCCESSFUL_PAYMENT_STATUSES.includes(String(payment.status || '').toLowerCase())) continue;
    const paidAt = payment.fulfilled_at || payment.created_at;
    if (!paidAt) continue;
    const gross = String(payment.currency || 'USD').toUpperCase() === 'NGN'
      ? money(Number(payment.amount || 0) / NGN_PER_USD)
      : money(payment.amount);
    if (new Date(paidAt) >= monthStart) revenueThisMonth += gross;
    if (new Date(paidAt) >= yearStart) revenueThisYear += gross;
  }

  const totalPlatformRevenue = money(periodPlatformFromEarnings);
  const totalCreatorEarnings = money(periodCreatorEarnings);
  const creatorPayoutTotals = money(payoutMetrics.paidWithdrawals || 0);
  const pendingRevenue = money(payoutMetrics.pendingAmount || 0);
  const processingFees = money(grossRevenue * (rates.processingFeePercent / 100));
  const taxEstimate = money(grossRevenue * (rates.taxPercent / 100));
  const netProfit = money(totalPlatformRevenue - creatorPayoutTotals - processingFees - taxEstimate);

  const earningsGrossDaily = [];
  const dailyMap = new Map();
  for (const payment of sources.coinPayments) {
    const productType = String(payment.product_type || '').toLowerCase();
    if (!/coin|token/.test(productType)) continue;
    if (!SUCCESSFUL_PAYMENT_STATUSES.includes(String(payment.status || '').toLowerCase())) continue;
    const paidAt = payment.fulfilled_at || payment.created_at;
    if (!inRange(paidAt, from, to)) continue;
    const day = String(paidAt || '').slice(0, 10);
    if (!day) continue;
    const amount = String(payment.currency || 'USD').toUpperCase() === 'NGN'
      ? money(Number(payment.amount || 0) / NGN_PER_USD)
      : money(payment.amount);
    dailyMap.set(day, money((dailyMap.get(day) || 0) + amount));
  }
  for (const row of sources.earnings) {
    if (!inRange(row.created_at, from, to)) continue;
    const day = String(row.created_at || '').slice(0, 10);
    if (!day) continue;
    const creatorAmt = money(row.amount_usd);
    const gross = row.gross_usd != null ? money(row.gross_usd) : grossFromCreatorShare(creatorAmt, rates.creatorPercent);
    dailyMap.set(day, money((dailyMap.get(day) || 0) + gross));
  }
  const revenueDaily = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, amount]) => ({ date, amount }));

  const topCreators = Array.from(creatorTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([creatorId, earnings]) => ({ creatorId, earnings }));

  const topPayers = Array.from(payerTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([userId, spent]) => ({ userId, spent }));

  let topCreatorsEnriched = topCreators;
  let topPayersEnriched = topPayers;
  if (supabase && topCreators.length) {
    const ids = topCreators.map((c) => c.creatorId);
    const { data: users } = await supabase.from('users').select('id, username, display_name, email').in('id', ids);
    const map = new Map((users || []).map((u) => [u.id, u]));
    topCreatorsEnriched = topCreators.map((c) => ({
      ...c,
      username: map.get(c.creatorId)?.username || null,
      displayName: map.get(c.creatorId)?.display_name || null,
      email: map.get(c.creatorId)?.email || null,
    }));
  }
  if (supabase && topPayers.length) {
    const ids = topPayers.map((p) => p.userId);
    const { data: users } = await supabase.from('users').select('id, username, display_name, email').in('id', ids);
    const map = new Map((users || []).map((u) => [u.id, u]));
    topPayersEnriched = topPayers.map((p) => ({
      ...p,
      username: map.get(p.userId)?.username || null,
      displayName: map.get(p.userId)?.display_name || null,
      email: map.get(p.userId)?.email || null,
    }));
  }

  const commissionTrend = revenueDaily.map((d) => ({
    date: d.date,
    platform: money(d.amount * (rates.platformPercent / 100)),
    creator: money(d.amount * (rates.creatorPercent / 100)),
  }));

  const adReward = await getAdRewardAnalytics({ from, to }).catch(() => ({
    validViews: 0,
    impressions: 0,
    creatorRewardsUsd: 0,
    platformGrossUsd: 0,
    netProfitUsd: 0,
  }));

  return {
    range: query.range || '30d',
    from: from.toISOString(),
    to: to.toISOString(),
    timezone,
    commissionRates: rates,
    totalPlatformRevenue,
    totalCreatorEarnings,
    platformCommissionEarnings: totalPlatformRevenue,
    coinPurchaseRevenue: money(coinPurchaseRevenue),
    videoPurchaseRevenue: money(videoPurchaseRevenue),
    tipRevenue: money(tipRevenue),
    creatorPayoutTotals,
    pendingRevenue,
    netProfit,
    grossRevenue,
    revenueThisMonth: money(revenueThisMonth),
    revenueThisYear: money(revenueThisYear),
    revenueGrowthPercent: growthPct(grossRevenue, prevGross),
    revenueDaily,
    revenueWeekly: bucketWeekly(revenueDaily),
    revenueMonthly: bucketMonthly(revenueDaily),
    topEarningCreators: topCreatorsEnriched,
    highestPayingUsers: topPayersEnriched,
    commissionTrend,
    coinPurchaseAnalytics: {
      count: sources.coinPayments.filter((payment) => {
        const productType = String(payment.product_type || '').toLowerCase();
        const paidAt = payment.fulfilled_at || payment.created_at;
        return /coin|token/.test(productType)
          && SUCCESSFUL_PAYMENT_STATUSES.includes(String(payment.status || '').toLowerCase())
          && inRange(paidAt, from, to);
      }).length,
      revenue: money(coinPurchaseRevenue),
    },
    payoutAnalytics: {
      pending: payoutMetrics.pendingAmount,
      completed: payoutMetrics.completedPayouts,
      avgHours: payoutMetrics.avgProcessingHours,
    },
    breakdown: [
      { name: 'Coin purchases', value: money(coinPurchaseRevenue) },
      { name: 'Video purchases', value: money(videoPurchaseRevenue) },
      { name: 'Tips & gifts', value: money(tipRevenue) },
      { name: 'Platform fees', value: totalPlatformRevenue },
      { name: 'Ad gross (est.)', value: money(adReward.platformGrossUsd) },
    ].filter((b) => b.value > 0),
    adRewardAnalytics: adReward,
    payoutMetrics,
  };
}

export async function getUnifiedFinanceDashboard(query = {}) {
  const [company, payout] = await Promise.all([
    getCompanyRevenueMetrics(query),
    getPayoutMetrics(query),
  ]);

  if (!payout) return { ...company, ...company?.payoutMetrics };

  return {
    ...payout,
    ...company,
    totalRevenue: company.grossRevenue,
    totalRevenueGrowth: company.revenueGrowthPercent,
    platformFees: company.platformCommissionEarnings,
    netPayoutTotals: money((payout.completedPayouts || 0) - company.platformCommissionEarnings),
    revenueDaily: company.revenueDaily,
    companyRevenue: company,
  };
}

export async function getCreatorEarningsForAdmin(userId) {
  return getUserEarningsSummary(userId);
}
