import PDFDocument from 'pdfkit';
import { Readable } from 'stream';
import { createGzip } from 'zlib';
import { supabase, isConfigured } from '../config/supabase.js';
import { listFinanceActivityEvents } from './financePayoutEvents.service.js';

const FETCH_LIMIT = 1200;
const MAX_EXPORT_ROWS = 5000;

const PAYMENT_TYPES = new Set([
  'coin_purchase',
  'membership_purchase',
  'creator_video_purchase',
  'creator_payout',
]);

const CSV_COLUMNS = [
  ['type', 'Type'],
  ['transactionId', 'Transaction ID'],
  ['status', 'Status'],
  ['provider', 'Provider'],
  ['userEmail', 'User email'],
  ['userName', 'User name'],
  ['creatorName', 'Creator'],
  ['item', 'Item'],
  ['amountUsd', 'Amount USD'],
  ['amountOriginal', 'Original amount'],
  ['currency', 'Currency'],
  ['coins', 'Coins'],
  ['creatorEarnings', 'Creator earnings'],
  ['companyEarnings', 'Company earnings'],
  ['walletBalanceBefore', 'Wallet before'],
  ['walletBalanceAfter', 'Wallet after'],
  ['approvedBy', 'Approved by'],
  ['expiresAt', 'Expires at'],
  ['date', 'Date'],
];

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function lower(value) {
  return text(value).trim().toLowerCase();
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function isMissingDbFeature(error) {
  if (!error) return false;
  return (
    error.code === '42P01' ||
    error.code === '42703' ||
    error.code === 'PGRST200' ||
    error.code === 'PGRST204' ||
    /schema cache|does not exist|column .* not found/i.test(error.message || '')
  );
}

async function safeRows(table, buildQuery, fallback = []) {
  if (!isConfigured() || !supabase) return fallback;
  try {
    const query = buildQuery(supabase.from(table));
    const { data, error } = await query;
    if (error) {
      if (!isMissingDbFeature(error)) {
        console.warn(`[payment-history] ${table} query failed:`, error.message || error);
      }
      return fallback;
    }
    return Array.isArray(data) ? data : fallback;
  } catch (error) {
    if (!isMissingDbFeature(error)) {
      console.warn(`[payment-history] ${table} query crashed:`, error.message || error);
    }
    return fallback;
  }
}

async function fetchRecent(table, orderColumn) {
  return safeRows(table, (from) => from
    .select('*')
    .order(orderColumn, { ascending: false })
    .limit(FETCH_LIMIT));
}

async function fetchUsers(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))].slice(0, 500);
  if (!unique.length) return new Map();
  const rows = await safeRows('users', (from) => from
    .select('id,email,username,display_name,name,avatar_url')
    .in('id', unique));
  return new Map(rows.map((row) => [String(row.id), row]));
}

async function fetchMembershipPlans(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))].slice(0, 500);
  if (!unique.length) return new Map();
  const rows = await safeRows('membership_plans', (from) => from
    .select('id,name,duration_days,price_usd,coins')
    .in('id', unique));
  return new Map(rows.map((row) => [String(row.id), row]));
}

async function fetchVideos(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))].slice(0, 500);
  if (!unique.length) return new Map();
  const rows = await safeRows('tiktok_videos', (from) => from
    .select('video_id,title,user_id,creator_display_name')
    .in('video_id', unique));
  return new Map(rows.map((row) => [String(row.video_id), row]));
}

function normalizeStatus(status, type = '') {
  const raw = lower(status);
  if (!raw) return 'pending';
  if (['completed', 'complete', 'fulfilled', 'paid', 'success', 'successful', 'active', 'grace', 'verified'].includes(raw)) {
    return 'completed';
  }
  if (['pending', 'created', 'checkout_created', 'processing', 'approved', 'queued', 'in_review'].includes(raw)) {
    return 'pending';
  }
  if (['refunded', 'refund', 'reversed', 'chargeback'].includes(raw)) {
    return 'refunded';
  }
  if (['cancelled', 'canceled', 'void', 'expired', 'revoked'].includes(raw)) {
    return type === 'membership_purchase' && raw === 'expired' ? 'completed' : 'cancelled';
  }
  if (['failed', 'declined', 'suspicious', 'rejected', 'error'].includes(raw)) {
    return 'failed';
  }
  return raw;
}

function statusLabel(status) {
  const normalized = normalizeStatus(status);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function displayName(user, fallback) {
  if (!user) return fallback || 'Unknown';
  return firstValue(user.display_name, user.name, user.username, user.email, fallback, 'Unknown');
}

function emailOf(user) {
  return firstValue(user?.email, '');
}

function productSnapshot(row) {
  const snapshot = row?.product_snapshot || row?.metadata?.product_snapshot || row?.metadata?.product || {};
  return snapshot && typeof snapshot === 'object' ? snapshot : {};
}

function amountUsd(row, fallbackKeys = ['amount_usd', 'purchase_amount_usd', 'amount', 'official_amount']) {
  const explicit = firstValue(row.amount_usd, row.purchase_amount_usd, row.creator_revenue_usd && row.platform_revenue_usd
    ? money(row.creator_revenue_usd) + money(row.platform_revenue_usd)
    : null);
  if (explicit !== null && explicit !== undefined && explicit !== '') return money(explicit);

  const snapshot = productSnapshot(row);
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const nested = firstValue(
    snapshot.price_usd,
    snapshot.amount_usd,
    snapshot.usd,
    metadata.amount_usd,
    metadata.price_usd,
    metadata.officialAmountUsd,
  );
  if (nested !== null && nested !== undefined && nested !== '') return money(nested);

  const currency = lower(row.currency || metadata.currency || snapshot.currency || 'USD');
  for (const key of fallbackKeys) {
    const value = row[key];
    if (value !== null && value !== undefined && value !== '' && currency === 'usd') return money(value);
  }
  return 0;
}

function originalAmount(row, fallback = 0) {
  return money(firstValue(row.amount, row.official_amount, row.purchase_amount_usd, row.amount_usd, fallback));
}

function recordDate(...values) {
  return firstValue(...values, new Date(0).toISOString());
}

function typeFromIntent(row) {
  const snapshot = productSnapshot(row);
  const value = lower(firstValue(row.product_type, snapshot.productType, snapshot.product_type, row.metadata?.productType));
  if (/coin|token/.test(value)) return 'coin_purchase';
  if (/membership|subscription|plan/.test(value)) return 'membership_purchase';
  return null;
}

function itemFromIntent(row, type) {
  const snapshot = productSnapshot(row);
  const productName = firstValue(
    snapshot.name,
    snapshot.productName,
    snapshot.product_name,
    snapshot.planName,
    snapshot.packageName,
    row.metadata?.productName,
    row.metadata?.planName,
    row.product_id,
  );
  if (productName) return text(productName);
  if (type === 'coin_purchase') return `${money(row.official_units || row.metadata?.coins)} coins`;
  return type === 'membership_purchase' ? 'Membership purchase' : 'Payment';
}

function coinAmount(row) {
  const snapshot = productSnapshot(row);
  return money(firstValue(
    row.coins,
    row.official_units,
    row.amount_tokens,
    row.metadata?.coins,
    row.metadata?.officialUnits,
    snapshot.coins,
    snapshot.officialUnits,
    snapshot.units,
  ));
}

function addRecord(records, seen, record) {
  if (!record?.id || !PAYMENT_TYPES.has(record.type)) return;
  const reference = lower(record.transactionId);
  const key = reference ? `${record.type}:${reference}` : `${record.type}:${record.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  records.push({
    direction: record.type === 'creator_payout' ? 'out' : 'in',
    currency: 'USD',
    provider: '',
    transactionId: '',
    status: 'pending',
    rawStatus: '',
    amountUsd: 0,
    amountOriginal: 0,
    coins: null,
    creatorEarnings: null,
    companyEarnings: null,
    walletBalanceBefore: null,
    walletBalanceAfter: null,
    approvedBy: null,
    expiresAt: null,
    metadata: {},
    ...record,
  });
}

function enrichRecord(record, userMap, creatorMap, approvedByMap, planMap, videoMap) {
  const user = userMap.get(String(record.userId || ''));
  const creator = creatorMap.get(String(record.creatorId || ''));
  const approver = approvedByMap.get(String(record.approvedById || ''));
  const plan = planMap.get(String(record.planId || ''));
  const video = videoMap.get(String(record.videoId || ''));
  const item = firstValue(record.item, record.videoTitle, video?.title, plan?.name);

  return {
    ...record,
    userName: firstValue(record.userName, displayName(user, record.userId ? `User ${String(record.userId).slice(0, 8)}` : '')),
    userEmail: firstValue(record.userEmail, emailOf(user)),
    creatorName: firstValue(record.creatorName, displayName(creator, video?.creator_display_name || (record.creatorId ? `Creator ${String(record.creatorId).slice(0, 8)}` : ''))),
    creatorEmail: firstValue(record.creatorEmail, emailOf(creator)),
    approvedBy: firstValue(record.approvedBy, displayName(approver, record.approvedById || '')),
    item: item || 'Transaction',
  };
}

function applyFilters(records, query) {
  const type = lower(firstValue(query.paymentType, query.type));
  const status = lower(firstValue(query.status, query.statusFilter));
  const provider = lower(firstValue(query.provider, query.methodFilter));
  const user = lower(query.user);
  const creator = lower(query.creator);
  const search = lower(query.search || query.q);
  const from = query.from || query.startDate || '';
  const to = query.to || query.endDate || '';
  const minAmount = query.minAmount !== undefined && query.minAmount !== '' ? Number(query.minAmount) : null;
  const maxAmount = query.maxAmount !== undefined && query.maxAmount !== '' ? Number(query.maxAmount) : null;
  const fromMs = from ? new Date(`${from}T00:00:00.000Z`).getTime() : null;
  const toMs = to ? new Date(`${to}T23:59:59.999Z`).getTime() : null;

  return records.filter((record) => {
    if (type && type !== 'all' && record.type !== type) return false;
    if (status && status !== 'all' && normalizeStatus(record.status) !== status) return false;
    if (provider && provider !== 'all' && !lower(record.provider).includes(provider)) return false;
    if (user && ![
      record.userId,
      record.userName,
      record.userEmail,
    ].some((field) => lower(field).includes(user))) return false;
    if (creator && ![
      record.creatorId,
      record.creatorName,
      record.creatorEmail,
    ].some((field) => lower(field).includes(creator))) return false;

    const amount = money(record.amountUsd || record.amountOriginal);
    if (minAmount !== null && Number.isFinite(minAmount) && amount < minAmount) return false;
    if (maxAmount !== null && Number.isFinite(maxAmount) && amount > maxAmount) return false;

    const dateMs = new Date(record.date || 0).getTime();
    if (fromMs !== null && Number.isFinite(fromMs) && dateMs < fromMs) return false;
    if (toMs !== null && Number.isFinite(toMs) && dateMs > toMs) return false;

    if (search) {
      const haystack = [
        record.transactionId,
        record.userEmail,
        record.userName,
        record.creatorName,
        record.creatorEmail,
        record.videoTitle,
        record.item,
        record.provider,
        record.status,
        record.id,
      ].map(lower).join(' ');
      if (!haystack.includes(search)) return false;
    }

    return true;
  });
}

function sortRecords(records, query) {
  const sortBy = lower(query.sortBy || 'date');
  const direction = lower(query.sortDirection || query.direction || 'desc') === 'asc' ? 1 : -1;
  const value = (record) => {
    if (sortBy === 'amount') return money(record.amountUsd || record.amountOriginal);
    if (sortBy === 'type') return record.type || '';
    if (sortBy === 'status') return record.status || '';
    if (sortBy === 'provider') return record.provider || '';
    if (sortBy === 'user') return record.userName || record.userEmail || '';
    if (sortBy === 'creator') return record.creatorName || record.creatorEmail || '';
    return new Date(record.date || 0).getTime();
  };
  return [...records].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * direction;
    return String(va).localeCompare(String(vb)) * direction;
  });
}

function computeStats(records) {
  const completedIncoming = records.filter((record) => record.direction === 'in' && normalizeStatus(record.status) === 'completed');
  const completedPayouts = records.filter((record) => record.type === 'creator_payout' && normalizeStatus(record.status) === 'completed');
  const pendingPayouts = records.filter((record) => record.type === 'creator_payout' && normalizeStatus(record.status) === 'pending');
  const memberships = records.filter((record) => record.type === 'membership_purchase' && normalizeStatus(record.status) === 'completed');
  const coins = records.filter((record) => record.type === 'coin_purchase' && normalizeStatus(record.status) === 'completed');

  return {
    totalTransactions: records.length,
    totalRevenue: completedIncoming.reduce((sum, record) => sum + money(record.amountUsd), 0),
    totalCreatorPayouts: completedPayouts.reduce((sum, record) => sum + money(record.amountUsd), 0),
    totalMembershipsSold: memberships.length,
    totalCoinsSold: coins.reduce((sum, record) => sum + money(record.coins), 0),
    pendingWithdrawals: pendingPayouts.length,
    pendingWithdrawalsAmount: pendingPayouts.reduce((sum, record) => sum + money(record.amountUsd), 0),
    failedTransactions: records.filter((record) => normalizeStatus(record.status) === 'failed').length,
    refundedTransactions: records.filter((record) => normalizeStatus(record.status) === 'refunded').length,
    completedTransactions: records.filter((record) => normalizeStatus(record.status) === 'completed').length,
  };
}

async function buildRecords() {
  const [
    paymentIntents,
    tokenCredits,
    walletTransactions,
    userMemberships,
    membershipBillingLogs,
    premiumPurchases,
    payoutRequests,
  ] = await Promise.all([
    fetchRecent('payment_intents', 'created_at'),
    fetchRecent('token_credits', 'created_at'),
    fetchRecent('coin_wallet_transactions', 'created_at'),
    fetchRecent('user_memberships', 'started_at'),
    fetchRecent('membership_billing_logs', 'created_at'),
    fetchRecent('premium_video_purchases', 'purchased_at'),
    fetchRecent('creator_payout_requests', 'requested_at'),
  ]);

  const records = [];
  const seen = new Set();
  const seenIntentIds = new Set();
  const seenMembershipRefs = new Set();
  const seenCoinRefs = new Set();

  for (const row of paymentIntents) {
    const type = typeFromIntent(row);
    if (!type) continue;
    seenIntentIds.add(String(row.id));
    const ref = firstValue(row.provider_reference, row.intent_key, row.id);
    if (type === 'membership_purchase') seenMembershipRefs.add(lower(ref));
    if (type === 'coin_purchase') seenCoinRefs.add(lower(ref));
    addRecord(records, seen, {
      id: `intent-${row.id}`,
      sourceTable: 'payment_intents',
      sourceId: row.id,
      type,
      userId: row.user_id,
      planId: type === 'membership_purchase' ? row.product_id : null,
      item: itemFromIntent(row, type),
      amountUsd: amountUsd(row),
      amountOriginal: originalAmount(row),
      currency: firstValue(row.currency, row.metadata?.currency, 'USD'),
      coins: type === 'coin_purchase' ? coinAmount(row) : null,
      provider: firstValue(row.provider, row.metadata?.provider, row.metadata?.gatewayPlan?.primary, ''),
      transactionId: ref,
      status: normalizeStatus(row.status, type),
      rawStatus: row.status,
      date: recordDate(row.fulfilled_at, row.created_at),
      expiresAt: row.expires_at || null,
      metadata: row.metadata || {},
    });
  }

  for (const row of tokenCredits) {
    if (row.intent_id && seenIntentIds.has(String(row.intent_id))) continue;
    const ref = firstValue(row.provider_reference, row.wallet_transaction_id, row.intent_id, row.id);
    if (seenCoinRefs.has(lower(ref))) continue;
    seenCoinRefs.add(lower(ref));
    addRecord(records, seen, {
      id: `token-credit-${row.id}`,
      sourceTable: 'token_credits',
      sourceId: row.id,
      type: 'coin_purchase',
      userId: row.user_id,
      item: `${money(row.coins)} coins`,
      amountUsd: amountUsd(row),
      amountOriginal: amountUsd(row),
      currency: 'USD',
      coins: coinAmount(row),
      provider: row.provider || '',
      transactionId: ref,
      status: 'completed',
      rawStatus: 'completed',
      date: recordDate(row.created_at),
      metadata: row.metadata || {},
    });
  }

  for (const row of walletTransactions) {
    if (lower(row.type) !== 'purchase') continue;
    const ref = firstValue(row.reference, row.id);
    if (seenCoinRefs.has(lower(ref))) continue;
    seenCoinRefs.add(lower(ref));
    addRecord(records, seen, {
      id: `wallet-purchase-${row.id}`,
      sourceTable: 'coin_wallet_transactions',
      sourceId: row.id,
      type: 'coin_purchase',
      userId: row.user_id,
      item: `${money(row.amount)} coins`,
      amountUsd: amountUsd(row),
      amountOriginal: money(row.amount),
      currency: firstValue(row.metadata?.currency, 'USD'),
      coins: money(row.amount),
      provider: row.provider || '',
      transactionId: ref,
      status: normalizeStatus(row.status, 'coin_purchase'),
      rawStatus: row.status,
      walletBalanceBefore: money(row.balance_before),
      walletBalanceAfter: money(row.balance_after),
      date: recordDate(row.created_at),
      metadata: row.metadata || {},
    });
  }

  for (const row of userMemberships) {
    const ref = firstValue(row.payment_reference, row.id);
    if (seenMembershipRefs.has(lower(ref))) continue;
    seenMembershipRefs.add(lower(ref));
    addRecord(records, seen, {
      id: `membership-${row.id}`,
      sourceTable: 'user_memberships',
      sourceId: row.id,
      type: 'membership_purchase',
      userId: row.user_id,
      planId: row.plan_id,
      item: 'Membership purchase',
      amountUsd: amountUsd(row, ['amount_paid_usd']),
      amountOriginal: money(row.amount_paid_usd),
      currency: 'USD',
      coins: row.coins_received == null ? null : money(row.coins_received),
      provider: row.payment_provider || '',
      transactionId: ref,
      status: normalizeStatus(row.status, 'membership_purchase'),
      rawStatus: row.status,
      date: recordDate(row.started_at, row.created_at),
      expiresAt: row.expires_at || null,
      metadata: row.metadata || {},
    });
  }

  for (const row of membershipBillingLogs) {
    const ref = firstValue(row.provider_reference, row.id);
    if (seenMembershipRefs.has(lower(ref))) continue;
    seenMembershipRefs.add(lower(ref));
    addRecord(records, seen, {
      id: `membership-billing-${row.id}`,
      sourceTable: 'membership_billing_logs',
      sourceId: row.id,
      type: 'membership_purchase',
      userId: row.user_id,
      item: row.billing_reason || 'Membership billing',
      amountUsd: amountUsd(row),
      amountOriginal: originalAmount(row),
      currency: firstValue(row.currency, 'USD'),
      provider: row.provider || '',
      transactionId: ref,
      status: normalizeStatus(row.status, 'membership_purchase'),
      rawStatus: row.status,
      date: recordDate(row.created_at),
      metadata: row.metadata || {},
    });
  }

  for (const row of premiumPurchases) {
    const refunded = normalizeStatus(row.refund_status) === 'refunded' || lower(row.refund_status) === 'completed';
    const status = refunded ? 'refunded' : normalizeStatus(row.access_status, 'creator_video_purchase');
    addRecord(records, seen, {
      id: `premium-video-${row.id}`,
      sourceTable: 'premium_video_purchases',
      sourceId: row.id,
      type: 'creator_video_purchase',
      userId: row.user_id,
      creatorId: row.creator_id,
      videoId: row.video_id || row.tiktok_video_id,
      videoTitle: row.video_title,
      item: row.video_title || 'Creator video purchase',
      amountUsd: amountUsd(row),
      amountOriginal: originalAmount(row, row.purchase_amount_usd),
      currency: firstValue(row.currency, 'USD'),
      coins: row.purchase_amount_tokens == null ? null : money(row.purchase_amount_tokens),
      creatorEarnings: money(row.creator_revenue_usd),
      companyEarnings: money(row.platform_revenue_usd),
      provider: row.payment_provider || 'coin_wallet',
      transactionId: firstValue(row.payment_reference, row.id),
      status,
      rawStatus: refunded ? row.refund_status : row.access_status,
      date: recordDate(row.purchased_at),
      metadata: row.metadata || {},
    });
  }

  for (const row of payoutRequests) {
    addRecord(records, seen, {
      id: `payout-${row.id}`,
      sourceTable: 'creator_payout_requests',
      sourceId: row.id,
      type: 'creator_payout',
      creatorId: row.creator_id,
      creatorName: firstValue(row.creator_name, row.channel_name, row.account_name),
      creatorEmail: row.creator_email || '',
      item: 'Creator withdrawal',
      amountUsd: money(row.amount_usd),
      amountOriginal: money(firstValue(row.amount_ngn, row.amount_usd)),
      currency: row.amount_ngn ? 'NGN' : 'USD',
      provider: firstValue(row.payment_provider, row.method, 'manual'),
      transactionId: firstValue(
        row.transaction_reference,
        row.flutterwave_transaction_reference,
        row.paystack_transaction_reference,
        row.reference_id,
        row.id,
      ),
      status: normalizeStatus(row.status, 'creator_payout'),
      rawStatus: row.status,
      walletBalanceBefore: row.wallet_balance_before == null ? null : money(row.wallet_balance_before),
      walletBalanceAfter: row.remaining_balance_after == null ? null : money(row.remaining_balance_after),
      approvedById: firstValue(row.approved_by, row.processed_by, row.finance_assignee_id),
      approvedBy: null,
      date: recordDate(row.paid_at, row.completed_at, row.processed_at, row.requested_at),
      metadata: row.payment_metadata || {},
    });
  }

  const userIds = records.map((record) => record.userId).filter(Boolean);
  const creatorIds = records.map((record) => record.creatorId).filter(Boolean);
  const approverIds = records.map((record) => record.approvedById).filter(Boolean);
  const planIds = records.map((record) => record.planId).filter(Boolean);
  const videoIds = records.map((record) => record.videoId).filter(Boolean);
  const [userMap, creatorMap, approvedByMap, planMap, videoMap] = await Promise.all([
    fetchUsers(userIds),
    fetchUsers(creatorIds),
    fetchUsers(approverIds),
    fetchMembershipPlans(planIds),
    fetchVideos(videoIds),
  ]);

  return records.map((record) => enrichRecord(record, userMap, creatorMap, approvedByMap, planMap, videoMap));
}

export async function getPaymentHistory(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const records = await buildRecords();
  const filtered = applyFilters(records, query);
  const sorted = sortRecords(filtered, query);
  const total = sorted.length;
  const offset = (page - 1) * limit;
  const paged = sorted.slice(offset, offset + limit);
  const stats = computeStats(filtered);
  let activity = [];
  try {
    const result = await listFinanceActivityEvents({ page: 1, limit: 12 });
    activity = result.events || [];
  } catch {
    activity = [];
  }

  return {
    records: paged,
    transactions: paged,
    payments: paged,
    total,
    page,
    limit,
    stats,
    activity,
  };
}

export async function getPaymentHistoryExportRows(query = {}) {
  const records = await buildRecords();
  return sortRecords(applyFilters(records, query), { ...query, sortBy: query.sortBy || 'date' })
    .slice(0, MAX_EXPORT_ROWS);
}

export async function getPaymentHistoryExport(query = {}) {
  const records = await buildRecords();
  const filtered = applyFilters(records, query);
  return {
    records: sortRecords(filtered, { ...query, sortBy: query.sortBy || 'date' }).slice(0, MAX_EXPORT_ROWS),
    stats: computeStats(filtered),
  };
}

function escapeCsv(value) {
  return `"${text(value).replace(/"/g, '""')}"`;
}

export function paymentHistoryToCsv(records) {
  return [
    CSV_COLUMNS.map(([, label]) => escapeCsv(label)).join(','),
    ...records.map((record) => CSV_COLUMNS.map(([key]) => escapeCsv(record[key])).join(',')),
  ].join('\n');
}

export function streamPaymentHistoryCsvGzip(res, records) {
  function* lines() {
    yield `${CSV_COLUMNS.map(([, label]) => escapeCsv(label)).join(',')}\n`;
    for (const record of records) {
      yield `${CSV_COLUMNS.map(([key]) => escapeCsv(record[key])).join(',')}\n`;
    }
  }
  return Readable.from(lines()).pipe(createGzip()).pipe(res);
}

function escapeXml(value) {
  return text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function paymentHistoryToExcelXml(records) {
  const header = CSV_COLUMNS.map(([, label]) => (
    `<Cell><Data ss:Type="String">${escapeXml(label)}</Data></Cell>`
  )).join('');
  const rows = records.map((record) => {
    const cells = CSV_COLUMNS.map(([key]) => {
      const value = record[key];
      const type = typeof value === 'number' ? 'Number' : 'String';
      return `<Cell><Data ss:Type="${type}">${escapeXml(value)}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('');

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Payment History">
  <Table>
   <Row>${header}</Row>
   ${rows}
  </Table>
 </Worksheet>
</Workbook>`;
}

export function streamPaymentHistoryPdf(res, records, stats) {
  const doc = new PDFDocument({ margin: 42, size: 'A4' });
  doc.pipe(res);

  doc.fontSize(18).text('Payment History', { align: 'left' });
  doc.moveDown(0.35);
  doc.fontSize(9).fillColor('#555').text(`Generated ${new Date().toISOString()}`);
  doc.moveDown(0.8);

  doc.fillColor('#111').fontSize(10).text(`Total revenue: $${money(stats.totalRevenue).toFixed(2)}`);
  doc.text(`Creator payouts: $${money(stats.totalCreatorPayouts).toFixed(2)}`);
  doc.text(`Memberships sold: ${stats.totalMembershipsSold}`);
  doc.text(`Coins sold: ${stats.totalCoinsSold}`);
  doc.text(`Pending withdrawals: ${stats.pendingWithdrawals}`);
  doc.text(`Failed transactions: ${stats.failedTransactions}`);
  doc.moveDown(0.8);

  const columns = [
    ['Date', 42, 80],
    ['Type', 126, 92],
    ['Ref', 220, 100],
    ['Party', 322, 120],
    ['Amount', 444, 62],
    ['Status', 508, 52],
  ];
  const drawHeader = () => {
    doc.fontSize(8).fillColor('#444');
    columns.forEach(([label, x, width]) => doc.text(label, x, doc.y, { width }));
    doc.moveDown(0.5);
    doc.moveTo(42, doc.y).lineTo(552, doc.y).strokeColor('#dddddd').stroke();
    doc.moveDown(0.4);
  };
  drawHeader();

  doc.fontSize(7).fillColor('#111');
  for (const record of records.slice(0, 140)) {
    if (doc.y > 748) {
      doc.addPage();
      drawHeader();
      doc.fontSize(7).fillColor('#111');
    }
    const y = doc.y;
    const party = record.type === 'creator_payout'
      ? firstValue(record.creatorName, record.creatorEmail, record.creatorId, '')
      : firstValue(record.userName, record.userEmail, record.userId, '');
    doc.text(new Date(record.date || 0).toLocaleDateString(), 42, y, { width: 80 });
    doc.text(record.type.replace(/_/g, ' '), 126, y, { width: 92 });
    doc.text(text(record.transactionId).slice(0, 24), 220, y, { width: 100 });
    doc.text(text(party).slice(0, 32), 322, y, { width: 120 });
    doc.text(`$${money(record.amountUsd).toFixed(2)}`, 444, y, { width: 62 });
    doc.text(statusLabel(record.status), 508, y, { width: 52 });
    doc.y = y + 20;
  }

  doc.end();
}
