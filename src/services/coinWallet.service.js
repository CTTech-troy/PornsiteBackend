import { randomUUID } from 'crypto';
import { supabase, isConfigured } from '../config/supabase.js';
import { createCheckout } from './paymentServiceClient.js';
import { sendGiftNotificationEmail } from './emailService.js';

export const STATIC_COIN_PACKAGES = [
  { id: 'tokens_30', coins: 30, bonusCoins: 0, priceUsd: 0.99, priceNgn: 1499, name: '30 Coins', description: 'Starter coin package', isActive: true, sortOrder: 10 },
  { id: 'tokens_100', coins: 100, bonusCoins: 0, priceUsd: 2.99, priceNgn: 4499, name: '100 Coins', description: 'Popular coin package', isActive: true, sortOrder: 20 },
  { id: 'tokens_300', coins: 300, bonusCoins: 0, priceUsd: 7.99, priceNgn: 11999, name: '300 Coins', description: 'Best value coin package', isActive: true, sortOrder: 30 },
];

const NGN_PER_USD = Number(process.env.NGN_PER_USD || 1600);

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

function roundCoins(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function assertPaymentAmountMatches({ paidAmount, expectedAmount, currency, productId }) {
  if (paidAmount == null) return;
  const paid = Number(paidAmount);
  const expected = Number(expectedAmount || 0);
  const tolerance = String(currency || '').toUpperCase() === 'NGN' ? 1 : 0.01;
  if (!Number.isFinite(paid) || Math.abs(paid - expected) > tolerance) {
    const err = new Error(`Payment amount mismatch for ${productId}`);
    err.code = 'PAYMENT_AMOUNT_MISMATCH';
    err.details = { paidAmount: paid, expectedAmount: expected, currency };
    throw err;
  }
}

export function parseLegacyTokenAmount(id) {
  const n = parseInt(String(id || '').replace(/^(tokens|coins)_/, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function normalizeCoinPackage(row) {
  if (!row) return null;
  const coins = roundCoins(row.coins ?? row.tokens ?? 0);
  const bonusCoins = roundCoins(row.bonus_coins ?? row.bonusCoins ?? 0);
  return {
    id: String(row.id),
    name: row.name || `${coins.toLocaleString()} Coins`,
    description: row.description || '',
    coins,
    tokens: coins,
    bonusCoins,
    totalCoins: roundCoins(coins + bonusCoins),
    priceUsd: toNumber(row.price_usd ?? row.priceUsd, 0),
    priceNgn: toNumber(row.price_ngn ?? row.priceNgn, 0),
    currency: String(row.currency || 'USD').toUpperCase(),
    isActive: row.is_active !== false && row.isActive !== false,
    sortOrder: toNumber(row.sort_order ?? row.sortOrder, 0),
    expiresAfterDays: row.expires_after_days ?? row.expiresAfterDays ?? null,
    metadata: row.metadata || {},
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
  };
}

function staticPackageFor(id) {
  const found = STATIC_COIN_PACKAGES.find((pkg) => pkg.id === id);
  if (found) return normalizeCoinPackage(found);
  const amount = parseLegacyTokenAmount(id);
  if (!amount) return null;
  return normalizeCoinPackage({
    id,
    name: `${amount.toLocaleString()} Coins`,
    coins: amount,
    price_usd: Math.max(0.99, amount * 0.01),
    price_ngn: Math.max(500, Math.round(amount * 0.01 * NGN_PER_USD)),
    is_active: true,
  });
}

export async function getCoinPackages({ includeInactive = false } = {}) {
  if (!isConfigured() || !supabase) return STATIC_COIN_PACKAGES.map(normalizeCoinPackage);

  try {
    let query = supabase.from('coin_packages').select('*').order('sort_order', { ascending: true }).order('coins', { ascending: true });
    if (!includeInactive) query = query.eq('is_active', true);
    const { data, error } = await query;
    if (error) {
      if (isMissingDbFeature(error)) return STATIC_COIN_PACKAGES.map(normalizeCoinPackage);
      throw error;
    }
    const packages = (data || []).map(normalizeCoinPackage).filter(Boolean);
    return packages.length ? packages : STATIC_COIN_PACKAGES.map(normalizeCoinPackage);
  } catch (error) {
    if (isMissingDbFeature(error)) return STATIC_COIN_PACKAGES.map(normalizeCoinPackage);
    throw error;
  }
}

export async function getCoinPackage(packageId, { includeInactive = false } = {}) {
  const packages = await getCoinPackages({ includeInactive });
  return packages.find((pkg) => pkg.id === packageId) || staticPackageFor(packageId);
}

export async function getCoinWallet(userId) {
  if (!userId) throw new Error('userId required');
  if (!isConfigured() || !supabase) return { userId, balance: 0, source: 'unconfigured' };

  try {
    await supabase.rpc('ensure_coin_wallet', { p_user_id: userId });
    const { data, error } = await supabase
      .from('coin_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      if (!isMissingDbFeature(error)) throw error;
      return getLegacyCoinWallet(userId);
    }
    return {
      id: data?.id || null,
      userId,
      balance: roundCoins(data?.balance ?? 0),
      lifetimePurchased: roundCoins(data?.lifetime_purchased ?? 0),
      lifetimeSpent: roundCoins(data?.lifetime_spent ?? 0),
      lifetimeReceived: roundCoins(data?.lifetime_received ?? 0),
      lifetimeAdjusted: roundCoins(data?.lifetime_adjusted ?? 0),
      source: 'coin_wallets',
    };
  } catch (error) {
    if (isMissingDbFeature(error)) return getLegacyCoinWallet(userId);
    throw error;
  }
}

async function getLegacyCoinWallet(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('coin_balance')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return {
    userId,
    balance: roundCoins(data?.coin_balance ?? 0),
    lifetimePurchased: 0,
    lifetimeSpent: 0,
    lifetimeReceived: 0,
    lifetimeAdjusted: 0,
    source: 'users.coin_balance',
  };
}

export async function listCoinTransactions(userId, { page = 1, limit = 25, type = '' } = {}) {
  if (!userId) throw new Error('userId required');
  if (!isConfigured() || !supabase) return { transactions: [], total: 0, page, limit };
  const from = (Math.max(1, Number(page) || 1) - 1) * Math.min(100, Math.max(1, Number(limit) || 25));
  const to = from + Math.min(100, Math.max(1, Number(limit) || 25)) - 1;

  try {
    let query = supabase
      .from('coin_wallet_transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, to);
    if (type) query = query.eq('type', type);
    const { data, error, count } = await query;
    if (error) {
      if (isMissingDbFeature(error)) return listLegacyTokenTransactions(userId, { page, limit, type });
      throw error;
    }
    return {
      transactions: (data || []).map(normalizeCoinTransaction),
      total: count || 0,
      page: Number(page) || 1,
      limit: Math.min(100, Math.max(1, Number(limit) || 25)),
    };
  } catch (error) {
    if (isMissingDbFeature(error)) return listLegacyTokenTransactions(userId, { page, limit, type });
    throw error;
  }
}

async function listLegacyTokenTransactions(userId, { page = 1, limit = 25 } = {}) {
  const from = (Math.max(1, Number(page) || 1) - 1) * Math.min(100, Math.max(1, Number(limit) || 25));
  const to = from + Math.min(100, Math.max(1, Number(limit) || 25)) - 1;
  const { data, error, count } = await supabase
    .from('token_transactions')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error && !isMissingDbFeature(error)) throw error;
  return {
    transactions: (data || []).map((row) => ({
      id: row.id,
      type: row.type,
      amount: roundCoins(row.amount),
      status: row.status || 'completed',
      reference: row.reference || null,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      legacy: true,
    })),
    total: count || 0,
    page: Number(page) || 1,
    limit: Math.min(100, Math.max(1, Number(limit) || 25)),
  };
}

export function normalizeCoinTransaction(row) {
  return {
    id: row.id,
    walletId: row.wallet_id || null,
    userId: row.user_id,
    type: row.type,
    amount: roundCoins(row.amount),
    balanceBefore: roundCoins(row.balance_before),
    balanceAfter: roundCoins(row.balance_after),
    status: row.status,
    provider: row.provider || null,
    reference: row.reference || null,
    relatedUserId: row.related_user_id || null,
    sourceType: row.source_type || null,
    sourceId: row.source_id || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

export async function createCoinPurchaseCheckout({
  userId,
  packageId,
  countryCode = 'US',
  customerEmail = '',
  customerName = 'Member',
}) {
  if (!userId) throw new Error('Authentication required');
  const pkg = await getCoinPackage(packageId);
  if (!pkg || (!pkg.isActive && process.env.NODE_ENV === 'production')) {
    throw new Error(`Unknown coin package: ${packageId}`);
  }

  const isNigeria = String(countryCode || '').trim().toUpperCase() === 'NG';
  const amount = isNigeria
    ? (pkg.priceNgn || Math.round(pkg.priceUsd * NGN_PER_USD))
    : (pkg.priceUsd || Math.round((pkg.priceNgn || 0) / NGN_PER_USD * 100) / 100);
  const currency = isNigeria ? 'NGN' : 'USD';
  const orderKey = `${userId}_${pkg.id}_${Date.now()}`;
  const idempotencyKey = `coins:${userId}:${pkg.id}:${Date.now()}:${randomUUID()}`;

  let orderId = null;
  if (supabase) {
    const { data, error } = await supabase
      .from('monetization_orders')
      .insert({
        order_key: orderKey,
        user_id: userId,
        product_type: 'coins',
        product_id: pkg.id,
        amount,
        currency,
        status: 'pending',
        idempotency_key: idempotencyKey,
        metadata: { package: pkg },
      })
      .select('id')
      .maybeSingle();
    if (!error) orderId = data?.id || null;
    else if (!isMissingDbFeature(error)) throw error;
  }

  const paymentResp = await createCheckout({
    orderId: orderKey,
    userId,
    planId: pkg.id,
    productType: 'coins',
    productId: pkg.id,
    countryCode: String(countryCode || 'US').trim().toUpperCase(),
    currency,
    amount,
    productName: `${pkg.totalCoins.toLocaleString()} Coins`,
    customerEmail,
    customerName,
    metadata: {
      orderId,
      idempotencyKey,
      coins: pkg.coins,
      bonusCoins: pkg.bonusCoins,
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

  return { ...paymentResp, orderId, orderKey, package: pkg };
}

export async function fulfillCoinPurchase({
  userId,
  packageId,
  orderKey = null,
  reference = null,
  provider = null,
  amountPaid = null,
  currency = 'USD',
  metadata = {},
}) {
  if (!userId || !packageId) throw new Error('userId and packageId required');
  const pkg = await getCoinPackage(packageId, { includeInactive: true });
  if (!pkg) throw new Error(`Unknown coin package: ${packageId}`);

  const existingOrder = await findMonetizationOrder({ reference, orderKey });
  if (['fulfilled', 'success', 'paid', 'completed'].includes(String(existingOrder?.status || '').toLowerCase())) {
    return { fulfilled: false, duplicate: true, balance: null, package: pkg };
  }

  const expectedAmount = String(currency || 'USD').toUpperCase() === 'NGN' ? pkg.priceNgn : pkg.priceUsd;
  assertPaymentAmountMatches({
    paidAmount: amountPaid,
    expectedAmount,
    currency,
    productId: pkg.id,
  });

  const amount = roundCoins(pkg.totalCoins || pkg.coins);
  const idempotencyKey = reference ? `coin_purchase:${reference}` : `coin_purchase:${orderKey || randomUUID()}`;
  const result = await creditCoins({
    userId,
    amount,
    type: 'purchase',
    reference,
    provider,
    idempotencyKey,
    sourceType: 'coin_package',
    sourceId: pkg.id,
    metadata: {
      ...metadata,
      packageId: pkg.id,
      coins: pkg.coins,
      bonusCoins: pkg.bonusCoins,
      amountPaid,
      currency,
    },
  });

  await markMonetizationOrderFulfilled({ order: existingOrder, reference, provider });

  return { fulfilled: true, balance: result.balance, transactionId: result.transactionId, package: pkg };
}

async function findMonetizationOrder({ reference, orderKey }) {
  if (!supabase || (!reference && !orderKey)) return null;
  try {
    const candidates = [
      reference ? { field: 'provider_reference', value: reference } : null,
      orderKey ? { field: 'order_key', value: orderKey } : null,
      orderKey ? { field: 'provider_reference', value: orderKey } : null,
    ].filter(Boolean);
    for (const candidate of candidates) {
      const { data, error } = await supabase
        .from('monetization_orders')
        .select('*')
        .eq(candidate.field, candidate.value)
        .limit(1);
      if (error) {
        if (isMissingDbFeature(error)) return null;
        throw error;
      }
      if (data?.[0]) return data[0];
    }
    return null;
  } catch (error) {
    if (isMissingDbFeature(error)) return null;
    throw error;
  }
}

async function markMonetizationOrderFulfilled({ order, reference, provider }) {
  if (!supabase || !order?.id) return;
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

export async function creditCoins({
  userId,
  amount,
  type = 'purchase',
  reference = null,
  provider = null,
  metadata = {},
  idempotencyKey = null,
  sourceType = null,
  sourceId = null,
}) {
  if (!userId || !amount) throw new Error('userId and amount required');
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('credit_coin_wallet', {
    p_user_id: userId,
    p_amount: Number(amount),
    p_type: type,
    p_reference: reference,
    p_metadata: metadata,
    p_idempotency_key: idempotencyKey,
    p_provider: provider,
    p_source_type: sourceType,
    p_source_id: sourceId,
  });

  if (error) {
    if (!isMissingDbFeature(error)) throw error;
    return legacyCreditCoins(userId, amount);
  }

  const row = Array.isArray(data) ? data[0] : data;
  return { balance: roundCoins(row?.new_balance ?? 0), transactionId: row?.transaction_id || null };
}

async function legacyCreditCoins(userId, amount) {
  const { data: row } = await supabase.from('users').select('coin_balance').eq('id', userId).maybeSingle();
  const next = roundCoins((Number(row?.coin_balance) || 0) + Number(amount));
  const { error } = await supabase.from('users').upsert({ id: userId, coin_balance: next }, { onConflict: 'id' });
  if (error) throw error;
  return { balance: next, transactionId: null, legacy: true };
}

export async function spendCoins({
  userId,
  amount,
  type = 'spend',
  reference = null,
  relatedUserId = null,
  metadata = {},
  idempotencyKey = null,
  sourceType = null,
  sourceId = null,
}) {
  if (!userId || !amount) throw new Error('userId and amount required');
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('debit_coin_wallet', {
    p_user_id: userId,
    p_amount: Number(amount),
    p_type: type,
    p_reference: reference,
    p_metadata: metadata,
    p_idempotency_key: idempotencyKey,
    p_related_user_id: relatedUserId,
    p_source_type: sourceType,
    p_source_id: sourceId,
  });

  if (error) {
    if (/insufficient/i.test(error.message || '')) {
      const err = new Error('Insufficient coins');
      err.code = 'INSUFFICIENT_TOKENS';
      throw err;
    }
    if (!isMissingDbFeature(error)) throw error;
    return legacySpendCoins(userId, amount);
  }

  const row = Array.isArray(data) ? data[0] : data;
  return { balance: roundCoins(row?.new_balance ?? 0), transactionId: row?.transaction_id || null };
}

async function legacySpendCoins(userId, amount) {
  const { data: row, error: readError } = await supabase.from('users').select('coin_balance').eq('id', userId).maybeSingle();
  if (readError) throw readError;
  const current = roundCoins(row?.coin_balance ?? 0);
  if (current < Number(amount)) {
    const err = new Error('Insufficient coins');
    err.code = 'INSUFFICIENT_TOKENS';
    throw err;
  }
  const next = roundCoins(current - Number(amount));
  const { error } = await supabase
    .from('users')
    .update({ coin_balance: next })
    .eq('id', userId)
    .gte('coin_balance', amount);
  if (error) throw error;
  return { balance: next, transactionId: null, legacy: true };
}

export async function transferCoins({
  senderId,
  recipientId,
  amount,
  reference = null,
  metadata = {},
  idempotencyKey = null,
  sourceType = 'transfer',
  sourceId = null,
}) {
  if (!senderId || !recipientId || !amount) throw new Error('senderId, recipientId and amount required');
  const coinAmount = roundCoins(amount);
  const maxTransfer = Number(process.env.MAX_COIN_TRANSFER || 100000);
  if (coinAmount <= 0 || coinAmount > maxTransfer) {
    throw new Error(`Transfer amount must be between 0 and ${maxTransfer}`);
  }
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('transfer_coin_wallet', {
    p_sender_id: senderId,
    p_recipient_id: recipientId,
    p_amount: coinAmount,
    p_reference: reference,
    p_metadata: metadata,
    p_idempotency_key: idempotencyKey,
    p_source_type: sourceType,
    p_source_id: sourceId,
  });

  if (error) {
    if (/insufficient/i.test(error.message || '')) {
      const err = new Error('Insufficient coins');
      err.code = 'INSUFFICIENT_TOKENS';
      throw err;
    }
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    senderBalance: roundCoins(row?.sender_balance ?? 0),
    recipientBalance: roundCoins(row?.recipient_balance ?? 0),
    transferId: row?.transfer_id || null,
  };
}

const GIFT_SELECT_COLUMNS = [
  'id',
  'name',
  'coin_cost',
  'emoji',
  'tone',
  'image_url',
  'animation_type',
  'category',
  'rarity',
  'is_active',
  'admin_created',
  'sort_order',
  'metadata',
  'created_at',
  'updated_at',
].join(',');
const GIFT_IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/svg+xml', 'svg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
]);
const STATIC_GIFT_CATALOG = [
  { id: 'heart_small', name: 'Heart', coin_cost: 5, emoji: 'heart', tone: 'warm', category: 'starter', rarity: 'common', is_active: true, admin_created: true, sort_order: 10 },
  { id: 'spark_small', name: 'Spark', coin_cost: 10, emoji: 'spark', tone: 'bright', category: 'starter', rarity: 'common', is_active: true, admin_created: true, sort_order: 20 },
];

function staticGiftCatalog() {
  return STATIC_GIFT_CATALOG
    .map(normalizeGiftCatalogRow)
    .filter((gift) => gift?.id && gift.isActive && gift.adminCreated && gift.coinCost > 0);
}

function giftUnavailableError(message = 'Gift catalog is not configured') {
  const err = new Error(message);
  err.code = 'GIFT_SYSTEM_UNAVAILABLE';
  return err;
}

export async function getGiftCatalog() {
  if (!isConfigured() || !supabase) {
    return staticGiftCatalog();
  }

  const { data, error } = await supabase
    .from('gift_catalog')
    .select(GIFT_SELECT_COLUMNS)
    .eq('is_active', true)
    .eq('admin_created', true)
    .order('sort_order', { ascending: true });

  if (error) {
    if (isMissingDbFeature(error)) return staticGiftCatalog();
    throw error;
  }

  const gifts = (data || [])
    .map(normalizeGiftCatalogRow)
    .filter((gift) => gift?.id && gift.isActive && gift.adminCreated && gift.coinCost > 0);
  return gifts.length ? gifts : staticGiftCatalog();
}

function normalizeGiftCatalogRow(row) {
  if (!row) return null;
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const imageUrl = row.image_url
    || metadata.imageUrl
    || metadata.image_url
    || metadata.iconUrl
    || metadata.icon_url
    || null;
  return {
    id: String(row.id || '').trim(),
    name: String(row.name || '').trim(),
    coinCost: Number(row.coin_cost || 0),
    price: Number(row.coin_cost || 0),
    emoji: row.emoji || metadata.emoji || null,
    tone: row.tone || null,
    imageUrl: typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl.trim() : null,
    animationType: row.animation_type || metadata.animationType || metadata.animation_type || 'float',
    category: row.category || metadata.category || 'general',
    rarity: row.rarity || metadata.rarity || 'common',
    sortOrder: Number(row.sort_order || 0),
    isActive: row.is_active !== false,
    adminCreated: row.admin_created === true,
    metadata,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

export async function getGiftCatalogAdmin({ includeInactive = true } = {}) {
  if (!isConfigured() || !supabase) {
    return [];
  }

  let query = supabase
    .from('gift_catalog')
    .select(GIFT_SELECT_COLUMNS)
    .eq('admin_created', true)
    .order('sort_order', { ascending: true });
  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) {
    if (isMissingDbFeature(error)) return [];
    throw error;
  }
  return (data || []).map(normalizeGiftCatalogRow);
}

export async function getActiveGiftById(giftId) {
  const id = String(giftId || '').trim();
  if (!id) throw new Error('giftId is required');

  if (!isConfigured() || !supabase) {
    throw giftUnavailableError('Gift catalog is not available');
  }

  const { data, error } = await supabase
    .from('gift_catalog')
    .select(GIFT_SELECT_COLUMNS)
    .eq('id', id)
    .eq('is_active', true)
    .eq('admin_created', true)
    .maybeSingle();

  if (error) {
    if (isMissingDbFeature(error)) throw giftUnavailableError('Gift catalog migration has not been applied');
    throw error;
  }
  const gift = normalizeGiftCatalogRow(data);
  if (!gift || !gift.adminCreated || !gift.isActive || gift.coinCost <= 0) {
    const err = new Error(`Unknown gift: ${id}`);
    err.code = 'GIFT_NOT_FOUND';
    throw err;
  }
  return gift;
}

function giftCatalogPayload(payload = {}, { partial = false } = {}) {
  const row = {};
  if (!partial || payload.id !== undefined) row.id = payload.id;
  if (!partial || payload.name !== undefined) row.name = String(payload.name || '').trim();
  if (payload.coinCost !== undefined || payload.coin_cost !== undefined || !partial) {
    row.coin_cost = Math.max(1, Math.floor(Number(payload.coinCost ?? payload.coin_cost ?? 0)));
  }
  if (payload.emoji !== undefined || !partial) row.emoji = payload.emoji ? String(payload.emoji).trim() : null;
  if (payload.tone !== undefined || !partial) row.tone = payload.tone ? String(payload.tone).trim() : null;
  if (payload.imageUrl !== undefined || payload.image_url !== undefined || !partial) {
    const imageUrl = String(payload.imageUrl ?? payload.image_url ?? '').trim();
    row.image_url = imageUrl && /^https?:\/\//i.test(imageUrl) ? imageUrl : null;
  }
  if (payload.animationType !== undefined || payload.animation_type !== undefined || !partial) {
    row.animation_type = String(payload.animationType ?? payload.animation_type ?? 'float').trim().slice(0, 40) || 'float';
  }
  if (payload.category !== undefined || !partial) {
    row.category = String(payload.category || 'general').trim().slice(0, 80) || 'general';
  }
  if (payload.rarity !== undefined || !partial) {
    row.rarity = String(payload.rarity || 'common').trim().slice(0, 40) || 'common';
  }
  if (payload.sortOrder !== undefined || payload.sort_order !== undefined || !partial) {
    row.sort_order = Number(payload.sortOrder ?? payload.sort_order ?? 0);
  }
  if (payload.isActive !== undefined || payload.is_active !== undefined || !partial) {
    row.is_active = payload.isActive ?? payload.is_active ?? true;
  }
  row.admin_created = true;
  if (payload.metadata !== undefined || !partial) {
    row.metadata = {
      ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
      adminCreated: true,
    };
  }
  if (!partial) row.updated_at = new Date().toISOString();
  else if (Object.keys(row).length) row.updated_at = new Date().toISOString();
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

export async function createGiftCatalogItem(payload = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const id = String(payload.id || `gift_${Date.now()}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
  if (!id) throw new Error('Gift ID is required');
  if (!String(payload.name || '').trim()) throw new Error('Gift name is required');
  const row = giftCatalogPayload({ ...payload, id }, { partial: false });
  const { data, error } = await supabase
    .from('gift_catalog')
    .upsert(row, { onConflict: 'id' })
    .select()
    .maybeSingle();
  if (error) throw error;
  return normalizeGiftCatalogRow(data);
}

export async function updateGiftCatalogItem(id, payload = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase
    .from('gift_catalog')
    .update(giftCatalogPayload(payload, { partial: true }))
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  const gift = normalizeGiftCatalogRow(data);
  if (!gift) throw new Error('Gift not found');
  return gift;
}

export async function toggleGiftCatalogItem(id, isActive) {
  return updateGiftCatalogItem(id, { isActive });
}

export async function deleteGiftCatalogItem(id) {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase
    .from('gift_catalog')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
  return true;
}

export async function resolveGiftCost(giftId) {
  return getActiveGiftById(giftId);
}

export async function uploadGiftImageAsset(file) {
  if (!file) throw new Error('Image file is required');
  if (!isConfigured() || !supabase) throw new Error('Storage not configured');
  const contentType = String(file.mimetype || '').toLowerCase();
  const ext = GIFT_IMAGE_TYPES.get(contentType);
  if (!ext) {
    const err = new Error('Gift image must be PNG, SVG, WebP, GIF, or JPG.');
    err.code = 'INVALID_GIFT_IMAGE';
    throw err;
  }

  const bucket = process.env.SUPABASE_GIFT_BUCKET || process.env.SUPABASE_IMAGE_BUCKET || 'images';
  const filename = `gifts/${randomUUID()}.${ext}`;
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(filename, file.buffer, { contentType, upsert: false });
  if (error) throw error;

  const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  return {
    url: `${baseUrl}/storage/v1/object/public/${bucket}/${data.path}`,
    path: data.path,
    bucket,
    contentType,
  };
}

function normalizeGiftSendResult(data, fallbackGift) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Gift failed');
  const gift = {
    ...fallbackGift,
    id: row.gift_id || fallbackGift.id,
    name: row.gift_name || fallbackGift.name,
    coinCost: Number(row.coin_cost || fallbackGift.coinCost || 0),
    price: Number(row.coin_cost || fallbackGift.price || 0),
    emoji: row.gift_emoji || fallbackGift.emoji || null,
    imageUrl: row.gift_image_url || fallbackGift.imageUrl || null,
    animationType: row.gift_animation_type || fallbackGift.animationType || 'float',
    category: row.gift_category || fallbackGift.category || 'general',
    rarity: row.gift_rarity || fallbackGift.rarity || 'common',
  };
  return {
    newBalance: roundCoins(row.sender_balance || 0),
    recipientBalance: roundCoins(row.recipient_balance || 0),
    giftId: row.transfer_id || null,
    senderTransactionId: row.sender_tx_id || null,
    recipientTransactionId: row.recipient_tx_id || null,
    liveGiftId: row.live_gift_id || null,
    totalGiftsAmount: row.total_gifts_amount != null ? Number(row.total_gifts_amount) : null,
    creatorAmount: roundCoins(row.creator_amount || 0),
    platformAmount: roundCoins(row.platform_amount || 0),
    gift,
  };
}

export async function sendCreatorGift({ userId, senderName, creatorId, streamId, giftId, gift = null }) {
  const resolvedId = String(giftId || gift?.id || '').trim();
  if (!creatorId || !streamId || !resolvedId) {
    throw new Error('creatorId, streamId, and giftId are required');
  }

  const catalogGift = await resolveGiftCost(resolvedId);
  const amount = Number(catalogGift.coinCost);
  const maxTransfer = Number(process.env.MAX_COIN_TRANSFER || 100000);
  if (amount <= 0 || amount > maxTransfer) {
    throw new Error('Invalid gift amount');
  }

  const idempotencyKey = `gift:${userId}:${creatorId}:${streamId}:${resolvedId}:${Date.now()}:${randomUUID()}`;
  const { data, error } = await supabase.rpc('send_catalog_gift', {
    p_sender_id: userId,
    p_creator_id: creatorId,
    p_stream_id: streamId,
    p_gift_id: resolvedId,
    p_sender_name: senderName || null,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    if (/insufficient/i.test(error.message || '')) {
      const err = new Error('Insufficient coins');
      err.code = 'INSUFFICIENT_TOKENS';
      throw err;
    }
    if (isMissingDbFeature(error)) {
      throw giftUnavailableError('Gift wallet migration has not been applied');
    }
    throw error;
  }

  const result = normalizeGiftSendResult(data, catalogGift);

  try {
    const [{ data: creator }, { data: stream }] = await Promise.all([
      supabase.from('users').select('email, username, display_name').eq('id', creatorId).maybeSingle(),
      supabase.from('lives').select('title').eq('id', streamId).maybeSingle(),
    ]);
    if (creator?.email) {
      await sendGiftNotificationEmail({
        to: creator.email,
        creatorName: creator.display_name || creator.username || 'Creator',
        senderName: senderName || 'A viewer',
        giftName: catalogGift.name || resolvedId,
        coinAmount: amount,
        streamTitle: stream?.title || 'Live session',
        receivedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.warn('[gifts] notification email failed:', err?.message || err);
  }

  return result;
}

export async function getGiftCatalogAnalytics(gifts = []) {
  const empty = {
    total: gifts.length,
    active: gifts.filter((gift) => gift.isActive).length,
    totalSent: 0,
    totalRevenue: 0,
    topGifts: [],
  };
  if (!supabase) return empty;
  try {
    const { data, error } = await supabase
      .from('live_gifts')
      .select('gift_type,gift_name,amount,created_at')
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) {
      if (isMissingDbFeature(error)) return empty;
      throw error;
    }
    const byId = new Map(gifts.map((gift) => [gift.id, { ...gift, sent: 0, revenue: 0 }]));
    let totalRevenue = 0;
    for (const row of data || []) {
      const id = String(row.gift_type || '').trim();
      const amount = Number(row.amount || 0);
      totalRevenue += amount;
      if (!byId.has(id)) continue;
      const item = byId.get(id);
      item.sent += 1;
      item.revenue += amount;
    }
    return {
      ...empty,
      totalSent: (data || []).length,
      totalRevenue: roundCoins(totalRevenue),
      topGifts: [...byId.values()]
        .filter((gift) => gift.sent > 0)
        .sort((a, b) => b.sent - a.sent || b.revenue - a.revenue)
        .slice(0, 5)
        .map((gift) => ({
          id: gift.id,
          name: gift.name,
          sent: gift.sent,
          revenue: roundCoins(gift.revenue),
        })),
    };
  } catch (error) {
    if (isMissingDbFeature(error)) return empty;
    throw error;
  }
}

export async function setCoinBalance({ userId, targetBalance, actorId = null, reason = 'Admin balance update' }) {
  const wallet = await getCoinWallet(userId);
  const delta = roundCoins(Number(targetBalance) - Number(wallet.balance || 0));
  if (delta === 0) return { balance: wallet.balance, transactionId: null };
  return adjustCoins({ userId, delta, actorId, reason });
}

export async function adjustCoins({ userId, delta, actorId = null, reason = 'Admin adjustment', reference = null, metadata = {} }) {
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('adjust_coin_wallet', {
    p_user_id: userId,
    p_delta: Number(delta),
    p_actor_id: actorId,
    p_reason: reason,
    p_reference: reference,
    p_metadata: metadata,
  });

  if (error) {
    if (!isMissingDbFeature(error)) throw error;
    const wallet = await getLegacyCoinWallet(userId);
    const next = roundCoins(Number(wallet.balance || 0) + Number(delta));
    if (next < 0) {
      const err = new Error('Insufficient coins');
      err.code = 'INSUFFICIENT_TOKENS';
      throw err;
    }
    const { error: updateError } = await supabase.from('users').update({ coin_balance: next }).eq('id', userId);
    if (updateError) throw updateError;
    return { balance: next, transactionId: null, legacy: true };
  }

  const row = Array.isArray(data) ? data[0] : data;
  return { balance: roundCoins(row?.new_balance ?? 0), transactionId: row?.transaction_id || null };
}

export async function createCoinPackage(payload = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const id = String(payload.id || `coins_${Date.now()}`).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const row = coinPackagePayload({ ...payload, id });
  const { data, error } = await supabase.from('coin_packages').insert(row).select().maybeSingle();
  if (error) throw error;
  return normalizeCoinPackage(data);
}

export async function updateCoinPackage(id, payload = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase
    .from('coin_packages')
    .update({ ...coinPackagePayload(payload, { partial: true }), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return normalizeCoinPackage(data);
}

export async function toggleCoinPackage(id, isActive) {
  return updateCoinPackage(id, { isActive });
}

export async function deleteCoinPackage(id) {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('coin_packages').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
  return true;
}

function coinPackagePayload(payload = {}, { partial = false } = {}) {
  const row = {};
  if (!partial || payload.id !== undefined) row.id = payload.id;
  if (!partial || payload.name !== undefined) row.name = String(payload.name || '').trim();
  if (payload.description !== undefined || !partial) row.description = String(payload.description || '').trim();
  if (payload.coins !== undefined || !partial) row.coins = Math.max(0, Number(payload.coins || 0));
  if (payload.bonusCoins !== undefined || payload.bonus_coins !== undefined || !partial) row.bonus_coins = Math.max(0, Number(payload.bonusCoins ?? payload.bonus_coins ?? 0));
  if (payload.priceUsd !== undefined || payload.price_usd !== undefined || !partial) row.price_usd = Math.max(0, Number(payload.priceUsd ?? payload.price_usd ?? 0));
  if (payload.priceNgn !== undefined || payload.price_ngn !== undefined || !partial) row.price_ngn = Math.max(0, Number(payload.priceNgn ?? payload.price_ngn ?? 0));
  if (payload.currency !== undefined || !partial) row.currency = String(payload.currency || 'USD').toUpperCase();
  if (payload.isActive !== undefined || payload.is_active !== undefined || !partial) row.is_active = payload.isActive ?? payload.is_active ?? true;
  if (payload.sortOrder !== undefined || payload.sort_order !== undefined || !partial) row.sort_order = Number(payload.sortOrder ?? payload.sort_order ?? 0);
  if (payload.expiresAfterDays !== undefined || payload.expires_after_days !== undefined) row.expires_after_days = payload.expiresAfterDays ?? payload.expires_after_days ?? null;
  if (payload.metadata !== undefined || !partial) row.metadata = payload.metadata || {};
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

export async function getCoinAnalytics() {
  if (!supabase) return emptyCoinAnalytics();
  try {
    const [walletsRes, txRes, packages] = await Promise.all([
      supabase.from('coin_wallets').select('balance,lifetime_purchased,lifetime_spent,lifetime_received'),
      supabase.from('coin_wallet_transactions').select('type,amount,status,created_at'),
      getCoinPackages({ includeInactive: true }),
    ]);
    if (walletsRes.error && !isMissingDbFeature(walletsRes.error)) throw walletsRes.error;
    if (txRes.error && !isMissingDbFeature(txRes.error)) throw txRes.error;
    const wallets = walletsRes.data || [];
    const txs = txRes.data || [];
    return {
      totalWallets: wallets.length,
      activePackages: packages.filter((pkg) => pkg.isActive).length,
      totalCoinLiability: roundCoins(wallets.reduce((sum, row) => sum + Number(row.balance || 0), 0)),
      totalCoinsSold: roundCoins(txs.filter((tx) => tx.type === 'purchase').reduce((sum, tx) => sum + Math.abs(Number(tx.amount || 0)), 0)),
      totalCoinsSpent: roundCoins(txs.filter((tx) => ['spend', 'gift_sent', 'transfer_out'].includes(tx.type)).reduce((sum, tx) => sum + Math.abs(Number(tx.amount || 0)), 0)),
      transactionCount: txs.length,
    };
  } catch (error) {
    if (isMissingDbFeature(error)) return emptyCoinAnalytics();
    throw error;
  }
}

function emptyCoinAnalytics() {
  return {
    totalWallets: 0,
    activePackages: 0,
    totalCoinLiability: 0,
    totalCoinsSold: 0,
    totalCoinsSpent: 0,
    transactionCount: 0,
  };
}
