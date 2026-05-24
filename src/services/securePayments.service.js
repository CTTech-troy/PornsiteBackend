import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { supabase, isConfigured } from '../config/supabase.js';
import { upstashRedis } from '../config/redis.js';
import { createCheckout } from './paymentServiceClient.js';
import { getCoinPackage, fulfillCoinPurchase } from './coinWallet.service.js';
import {
  activateMembershipFromPayment,
  getMembershipPlan,
} from './membershipLifecycle.service.js';
import {
  normalizeWebhookPayload,
  verifyProviderTransaction,
  verifyWebhookSignature,
} from './paymentGateway.service.js';
import {
  countryFromRequest,
  normalizeCountryCode,
  resolveCheckoutCountry,
} from './paymentRegion.service.js';
import {
  resolveCheckoutProviders,
  userFacingPaymentError,
} from './paymentOrchestrator.service.js';
import { logPaymentEvent } from './paymentLogger.service.js';
import {
  sendPaymentFailureEmail,
  sendPaymentSuccessEmail,
} from './emailService.js';
import { writeFinanceActivityEvent } from './financePayoutEvents.service.js';

const NGN_PER_USD = Number(process.env.NGN_PER_USD || 1600);
const INTENT_TTL_MINUTES = Number(process.env.PAYMENT_INTENT_TTL_MINUTES || 30);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const MAX_COIN_TRANSFER = Number(process.env.MAX_COIN_TRANSFER || 100000);
const AUDIT_HASH_SECRET = process.env.PAYMENT_AUDIT_HASH_SECRET
  || process.env.SESSION_JWT_SECRET
  || process.env.JWT_SECRET
  || 'local-payment-audit';

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

async function runOptionalPaymentQuery(query, context, fallback = null) {
  try {
    const result = await query;
    if (result?.error) {
      if (!isMissingDbFeature(result.error)) {
        console.warn(`[payments] ${context} failed:`, result.error.message || result.error);
      }
      return fallback;
    }
    return result;
  } catch (err) {
    if (!isMissingDbFeature(err)) {
      console.warn(`[payments] ${context} failed:`, err?.message || err);
    }
    return fallback;
  }
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeProductType(value, productId = '') {
  const type = String(value || '').trim().toLowerCase();
  if (['coin', 'coins', 'token', 'tokens'].includes(type)) return 'coins';
  if (['membership', 'subscription', 'plan'].includes(type)) return 'membership';
  const id = String(productId || '').toLowerCase();
  return id.startsWith('tokens_') || id.startsWith('coins_') ? 'coins' : 'membership';
}

function hashValue(value) {
  if (!value) return null;
  return crypto.createHmac('sha256', AUDIT_HASH_SECRET).update(String(value)).digest('hex');
}

function clientIp(req) {
  return req?.ip || req?.headers?.['x-forwarded-for']?.split(',')?.[0]?.trim() || null;
}

function headersForAudit(req) {
  return {
    'user-agent': req.get?.('user-agent') || null,
    'x-forwarded-for': req.get?.('x-forwarded-for') || null,
    'x-real-ip': req.get?.('x-real-ip') || null,
    'stripe-signature': req.get?.('stripe-signature') ? '[present]' : null,
    'x-paystack-signature': req.get?.('x-paystack-signature') ? '[present]' : null,
    'verif-hash': req.get?.('verif-hash') ? '[present]' : null,
  };
}

async function officialProduct({ productType, productId, countryCode }) {
  const type = normalizeProductType(productType, productId);
  const isNigeria = String(countryCode || '').toUpperCase() === 'NG';
  const currency = isNigeria ? 'NGN' : 'USD';

  if (type === 'coins') {
    const pkg = await getCoinPackage(productId);
    if (!pkg || (!pkg.isActive && process.env.NODE_ENV === 'production')) {
      throw new Error(`Unknown coin package: ${productId}`);
    }
    const amount = isNigeria
      ? (pkg.priceNgn || Math.round(pkg.priceUsd * NGN_PER_USD))
      : (pkg.priceUsd || money((pkg.priceNgn || 0) / NGN_PER_USD));
    return {
      productType: 'coins',
      productId: pkg.id,
      productName: pkg.name || `${pkg.totalCoins} Coins`,
      amount: money(amount),
      currency,
      officialUnits: Number(pkg.totalCoins || pkg.coins || 0),
      snapshot: pkg,
    };
  }

  const plan = await getMembershipPlan(productId);
  if (!plan || (!plan.isActive && process.env.NODE_ENV === 'production')) {
    throw new Error(`Unknown membership plan: ${productId}`);
  }
  const amount = isNigeria
    ? (plan.price_ngn || Math.round(plan.price_usd * NGN_PER_USD))
    : (plan.price_usd || money((plan.price_ngn || 0) / NGN_PER_USD));
  return {
    productType: 'membership',
    productId: plan.id,
    productName: plan.name,
    amount: money(amount),
    currency,
    officialUnits: 0,
    snapshot: plan,
  };
}

function amountToUsd(amount, currency) {
  return String(currency || 'USD').toUpperCase() === 'NGN'
    ? money(Number(amount || 0) / NGN_PER_USD)
    : money(amount);
}

async function fetchPaymentUser(userId) {
  if (!supabase || !userId) return null;
  const { data } = await supabase
    .from('users')
    .select('email, username, display_name, coin_balance')
    .eq('id', userId)
    .maybeSingle();
  return data || null;
}

async function sendPaymentReceiptEmail({ intent, status, provider, reference, amount, currency, reason }) {
  try {
    const user = await fetchPaymentUser(intent?.user_id);
    if (!user?.email) return;
    const product = intent?.product_snapshot || {};
    const productName = product.name || product.productName || `${intent.product_type}: ${intent.product_id}`;
    const payload = {
      to: user.email,
      name: user.display_name || user.username || user.email.split('@')[0],
      productName,
      amountUsd: amountToUsd(amount ?? intent?.amount, currency || intent?.currency),
      transactionId: reference || intent?.provider_reference || intent?.intent_key,
      provider: provider || intent?.provider,
      walletBalance: user.coin_balance,
    };
    if (status === 'success') {
      await sendPaymentSuccessEmail({ ...payload, paidAt: new Date().toISOString() });
    } else {
      await sendPaymentFailureEmail({
        ...payload,
        failedAt: new Date().toISOString(),
        reason: reason || 'The payment could not be completed.',
      });
    }
  } catch (err) {
    console.warn('[payments] email receipt failed:', err?.message || err);
  }
}

async function detectRisk({ userId, ipHash }) {
  const flags = [];
  let score = 0;

  if (upstashRedis && userId) {
    try {
      const key = `payment:risk:user:${userId}`;
      const count = await upstashRedis.incr(key);
      await upstashRedis.expire(key, 10 * 60);
      if (Number(count) > Number(process.env.PAYMENT_RAPID_PURCHASE_LIMIT || 8)) {
        flags.push('rapid_purchase_velocity');
        score += 35;
      }
    } catch (error) {
      console.warn('[payments] Redis risk counter failed:', error.message);
    }
  }

  if (supabase && userId) {
    try {
      const since = new Date(Date.now() - 10 * 60_000).toISOString();
      const { count } = await supabase
        .from('payment_intents')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', since);
      if (Number(count || 0) > Number(process.env.PAYMENT_RAPID_PURCHASE_LIMIT || 8)) {
        flags.push('recent_intent_velocity');
        score += 25;
      }
    } catch (error) {
      if (!isMissingDbFeature(error)) console.warn('[payments] DB risk counter failed:', error.message);
    }
  }

  if (!ipHash) {
    flags.push('missing_ip');
    score += 5;
  }

  return { score: Math.min(100, score), flags };
}

export async function createSecurePaymentSession({
  userId,
  productType,
  productId,
  provider = '',
  countryCode = 'US',
  billingCountry = null,
  customerEmail = '',
  customerName = 'Member',
  customerPhone = '',
  inlineCheckout = true,
  req = null,
}) {
  if (!userId) throw new Error('Authentication required');
  if (!productId) throw new Error('productId is required');

  const ipCountry = countryFromRequest(req);
  const checkoutCountry = resolveCheckoutCountry({
    countryCode,
    billingCountry,
    ipCountry,
  });
  const gatewayPlan = await resolveCheckoutProviders({ explicitProvider: provider });

  if (!gatewayPlan.primary) {
    throw new Error('Payments are temporarily unavailable.');
  }

  const product = await officialProduct({ productType, productId, countryCode: checkoutCountry });
  const intentKey = `pi_${Date.now()}_${randomUUID()}`;
  const idempotencyKey = `payment_intent:${intentKey}`;
  const expiresAt = new Date(Date.now() + Math.max(5, INTENT_TTL_MINUTES) * 60_000).toISOString();
  const ipHash = hashValue(clientIp(req));
  const userAgentHash = hashValue(req?.get?.('user-agent') || '');
  const risk = await detectRisk({ userId, ipHash });

  let intentId = null;
  if (isConfigured() && supabase) {
    const { data, error } = await supabase
      .from('payment_intents')
      .insert({
        intent_key: intentKey,
        user_id: userId,
        product_type: product.productType,
        product_id: product.productId,
        amount: product.amount,
        official_amount: product.amount,
        currency: product.currency,
        official_units: product.officialUnits,
        status: risk.score >= 90 ? 'suspicious' : 'created',
        idempotency_key: idempotencyKey,
        expires_at: expiresAt,
        request_ip_hash: ipHash,
        user_agent_hash: userAgentHash,
        risk_score: risk.score,
        risk_flags: risk.flags,
        product_snapshot: product.snapshot,
        metadata: {
          countryCode: checkoutCountry,
          billingCountry: normalizeCountryCode(billingCountry) || checkoutCountry,
          ipCountry,
          provider: gatewayPlan.primary,
          fallbackProvider: gatewayPlan.fallback,
          gatewayPlan,
        },
      })
      .select('id')
      .maybeSingle();

    if (error && !isMissingDbFeature(error)) throw error;
    intentId = data?.id || null;

    if (intentId) {
      await writeAudit({
        intentId,
        userId,
        eventType: 'payment.intent_created',
        actorType: 'user',
        actorId: userId,
        ipHash,
        message: 'Server-created payment intent from official product catalog',
        metadata: { product, risk },
      });
    }
  }

  if (risk.score >= 90) {
    await writeFraudLog({
      userId,
      intentId,
      reason: 'Payment session blocked by fraud velocity controls',
      riskScore: risk.score,
      riskFlags: risk.flags,
      metadata: { productId: product.productId },
    });
    throw new Error('Payment session requires review.');
  }

  logPaymentEvent('info', 'checkout.create', {
    userId,
    productType: product.productType,
    productId: product.productId,
    provider: gatewayPlan.primary,
    fallbackProvider: gatewayPlan.fallback,
    country: checkoutCountry,
    amount: product.amount,
    currency: product.currency,
  });

  let checkout;
  try {
    checkout = await createCheckout({
      orderId: intentKey,
      userId,
      planId: product.productId,
      productType: product.productType,
      productId: product.productId,
      provider: gatewayPlan.primary,
      primaryProvider: gatewayPlan.primary,
      fallbackProvider: gatewayPlan.fallback,
      allowFallback: gatewayPlan.allowFallback,
      flutterwaveEnabled: gatewayPlan.flutterwaveEnabled,
      paystackEnabled: gatewayPlan.paystackEnabled,
      maxRetries: gatewayPlan.maxRetries,
      retryDelayMs: gatewayPlan.retryDelayMs,
      timeoutMs: gatewayPlan.timeoutMs,
      countryCode: checkoutCountry,
      currency: product.currency,
      amount: product.amount,
      productName: product.productName,
      customerEmail,
      customerName,
      customerPhone,
      inlineCheckout: gatewayPlan.primary === 'flutterwave' && inlineCheckout,
      metadata: {
        paymentIntentId: intentId,
        intentKey,
        idempotencyKey,
        officialAmount: product.amount,
        officialUnits: product.officialUnits,
      },
    });
  } catch (err) {
    logPaymentEvent('error', 'checkout.create_failed', {
      userId,
      productId: product.productId,
      primary: gatewayPlan.primary,
      fallback: gatewayPlan.fallback,
      error: err?.message,
    });
    if (intentId && supabase) {
      await runOptionalPaymentQuery(
        supabase
          .from('payment_intents')
          .update({
            status: 'failed',
            metadata: {
              countryCode: checkoutCountry,
              gatewayPlan,
              failure: err?.message,
            },
            updated_at: new Date().toISOString(),
          })
          .eq('id', intentId),
        'mark failed payment intent',
      );
    }
    throw new Error(userFacingPaymentError(err));
  }

  if (supabase && intentId) {
    await supabase
      .from('payment_intents')
      .update({
        provider: checkout.provider,
        provider_reference: checkout.reference,
        checkout_url: checkout.checkoutUrl,
        status: 'checkout_created',
        metadata: {
          countryCode: checkoutCountry,
          billingCountry: normalizeCountryCode(billingCountry) || checkoutCountry,
          ipCountry,
          provider: checkout.provider,
          gatewayPlan,
          fallbackUsed: checkout.fallbackUsed === true,
          retryCount: checkout.retryCount || 0,
          attemptedProviders: checkout.attemptedProviders || [],
          gatewayLog: checkout.gatewayLog || null,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', intentId);

    if (process.env.PAYMENT_ENABLE_LEGACY_ORDERS === 'true') {
      await runOptionalPaymentQuery(
        supabase
          .from('monetization_orders')
          .insert({
            order_key: intentKey,
            user_id: userId,
            product_type: product.productType,
            product_id: product.productId,
            amount: product.amount,
            currency: product.currency,
            provider: checkout.provider,
            provider_reference: checkout.reference,
            checkout_url: checkout.checkoutUrl,
            status: 'checkout_created',
            idempotency_key: idempotencyKey,
            metadata: { paymentIntentId: intentId, product },
          })
          .select('id')
          .maybeSingle(),
        'create legacy monetization order',
      );
    }
  }

  return {
    provider: checkout.provider,
    checkoutUrl: checkout.checkoutUrl || null,
    reference: checkout.reference,
    paymentIntentId: intentId,
    orderId: intentId,
    orderKey: intentKey,
    expiresAt,
    countryCode: checkoutCountry,
    currency: product.currency,
    amount: product.amount,
    flutterwave: checkout.flutterwave || null,
  };
}

export async function processProviderWebhook(provider, req) {
  const signature = verifyWebhookSignature(provider, req);
  const normalized = normalizeWebhookPayload(provider, req);

  const eventRecord = await recordWebhookEvent({
    provider,
    normalized,
    signatureValid: signature.valid,
    headers: headersForAudit(req),
  });

  if (signature.skipped) {
    return { accepted: false, status: 503, message: 'Webhook signature verification is not configured.' };
  }

  if (!signature.valid) {
    await writeFraudLog({
      provider,
      providerReference: normalized.reference,
      reason: `Invalid ${provider} webhook signature`,
      riskScore: 100,
      riskFlags: ['invalid_webhook_signature'],
      metadata: { signatureReason: signature.reason || null },
    });
    return { accepted: false, status: 401, message: 'Invalid webhook signature.' };
  }

  if (eventRecord.duplicate) {
    return { accepted: true, duplicate: true, message: 'Duplicate webhook ignored.' };
  }

  if (!normalized.successful) {
    if (normalized.pending) {
      await markWebhookProcessed(eventRecord.id, 'pending');
      logPaymentEvent('info', 'webhook.pending', {
        provider,
        reference: normalized.reference,
        eventType: normalized.eventType,
      });
      return { accepted: true, pending: true, eventType: normalized.eventType };
    }
    if (normalized.failed) {
      const failedIntent = await findPaymentIntent({
        provider,
        providerReference: normalized.reference,
        orderKey: normalized.orderKey,
      });
      if (failedIntent?.id && supabase) {
        await supabase
          .from('payment_intents')
          .update({
            status: 'failed',
            metadata: { ...(failedIntent.metadata || {}), failureEvent: normalized.raw },
            updated_at: new Date().toISOString(),
          })
          .eq('id', failedIntent.id)
          .then(() => null, () => null);
      } else {
        await markIntentByReference(normalized.reference, {
          status: 'failed',
          metadata: { failureEvent: normalized.raw },
        });
      }
      if (failedIntent) {
        await sendPaymentReceiptEmail({
          intent: failedIntent,
          status: 'failure',
          provider,
          reference: normalized.reference,
          amount: normalized.amount,
          currency: normalized.currency,
          reason: normalized.failureReason || normalized.message || 'Payment provider reported a failed payment.',
        });
        await writeFinanceActivityEvent({
          eventType: 'payment_failed',
          userId: failedIntent.user_id,
          productType: failedIntent.product_type,
          productId: failedIntent.product_id,
          amountUsd: amountToUsd(normalized.amount ?? failedIntent.amount, normalized.currency || failedIntent.currency),
          provider,
          reference: normalized.reference,
          status: 'failed',
          metadata: {
            paymentIntentId: failedIntent.id,
            eventType: normalized.eventType,
            reason: normalized.failureReason || normalized.message || 'Payment provider reported a failed payment.',
          },
        });
      }
      logPaymentEvent('warn', 'webhook.failed', {
        provider,
        reference: normalized.reference,
        eventType: normalized.eventType,
      });
    }
    await markWebhookProcessed(eventRecord.id, normalized.failed ? 'failed' : 'processed');
    return { accepted: true, ignored: true, eventType: normalized.eventType };
  }

  let verified;
  try {
    verified = await verifyProviderTransaction(provider, {
      ...normalized,
      orderKey: normalized.orderKey || null,
    });
  } catch (error) {
    await writeFraudLog({
      provider,
      providerReference: normalized.reference,
      reason: `Provider verification failed: ${error.message}`,
      riskScore: 90,
      riskFlags: ['provider_verification_failed'],
      metadata: { eventType: normalized.eventType },
    });
    await markWebhookProcessed(eventRecord.id, 'failed', error.message);
    return { accepted: true, verified: false, error: error.message };
  }

  const fulfillment = await fulfillVerifiedProviderPayment({
    provider,
    normalized,
    verified,
    source: 'webhook',
  });

  if (fulfillment.suspicious) {
    await markWebhookProcessed(eventRecord.id, 'rejected', fulfillment.reason || 'Suspicious payment');
    return { accepted: true, fulfilled: false, suspicious: true };
  }
  if (fulfillment.error) {
    await markWebhookProcessed(eventRecord.id, 'failed', fulfillment.error);
    return { accepted: true, fulfilled: false, error: fulfillment.error };
  }

  await markWebhookProcessed(eventRecord.id, 'processed');
  return {
    accepted: true,
    fulfilled: true,
    duplicate: fulfillment.duplicate,
    result: fulfillment.result,
  };
}

async function fulfillVerifiedProviderPayment({ provider, normalized = {}, verified, source = 'manual' }) {
  const reference = verified.reference || normalized.reference;
  const intent = await findPaymentIntent({
    provider,
    providerReference: reference,
    orderKey: verified.orderKey || normalized.orderKey,
  });

  if (!intent) {
    await writeFraudLog({
      provider,
      providerReference: reference,
      reason: 'Verified provider payment did not match any server-created payment intent',
      riskScore: 95,
      riskFlags: ['unknown_payment_intent'],
      metadata: { verified, source },
    });
    return { fulfilled: false, suspicious: true, reason: 'Unknown payment intent' };
  }

  const metadataMismatch = [
    verified.userId && verified.userId !== intent.user_id,
    normalizeProductType(verified.productType, verified.productId) !== normalizeProductType(intent.product_type, intent.product_id),
    verified.productId && verified.productId !== intent.product_id,
  ].some(Boolean);

  if (metadataMismatch) {
    await markIntentSuspicious(intent, 'provider_metadata_mismatch', { verified, normalized, source });
    return { fulfilled: false, suspicious: true, reason: 'Provider metadata mismatch', intent };
  }

  try {
    const result = await fulfillVerifiedIntent({
      intent,
      provider,
      reference,
      amount: verified.amount,
      currency: verified.currency,
      verification: verified,
      event: {
        ...normalized,
        eventType: normalized.eventType || `payment.${source}.verified`,
      },
    });
    if (result?.duplicate !== true) {
      await sendPaymentReceiptEmail({
        intent,
        status: 'success',
        provider,
        reference,
        amount: verified.amount,
        currency: verified.currency,
      });
      await writeAudit({
        intentId: intent.id,
        userId: intent.user_id,
        eventType: `payment.fulfilled.${source}`,
        message: 'Verified provider payment fulfilled product entitlement',
        metadata: { provider, reference, productType: intent.product_type, productId: intent.product_id },
      });
      await writeFinanceActivityEvent({
        eventType: normalizeProductType(intent.product_type, intent.product_id) === 'coins'
          ? 'coins_purchased'
          : 'membership_purchased',
        userId: intent.user_id,
        productType: intent.product_type,
        productId: intent.product_id,
        amountUsd: amountToUsd(verified.amount, verified.currency),
        amountTokens: normalizeProductType(intent.product_type, intent.product_id) === 'coins'
          ? intent.official_units
          : null,
        provider,
        reference,
        status: 'fulfilled',
        metadata: {
          paymentIntentId: intent.id,
          currency: verified.currency,
          providerAmount: verified.amount,
          result,
        },
      });
    }
    return { fulfilled: true, result, duplicate: result?.duplicate === true, intent };
  } catch (error) {
    await markIntentSuspicious(intent, error.code || 'fulfillment_failed', { message: error.message, verified, source });
    await sendPaymentReceiptEmail({
      intent,
      status: 'failure',
      provider,
      reference,
      amount: verified.amount,
      currency: verified.currency,
      reason: error.message,
    });
    await writeFinanceActivityEvent({
      eventType: 'payment_failed',
      userId: intent.user_id,
      productType: intent.product_type,
      productId: intent.product_id,
      amountUsd: amountToUsd(verified.amount, verified.currency),
      provider,
      reference,
      status: 'failed',
      metadata: {
        paymentIntentId: intent.id,
        reason: error.message,
        currency: verified.currency,
      },
    });
    return { fulfilled: false, error: error.message, intent };
  }
}

async function fulfillVerifiedIntent({ intent, provider, reference, amount, currency, verification, event }) {
  if (!supabase) {
    throw new Error('Supabase not configured');
  }

  if (normalizeProductType(intent.product_type, intent.product_id) === 'coins') {
    const { data, error } = await supabase.rpc('secure_fulfill_coin_payment', {
      p_intent_id: intent.id,
      p_provider: provider,
      p_provider_reference: reference,
      p_amount: Number(amount),
      p_currency: currency,
      p_verification: verification.raw || verification,
      p_event: event.raw || event,
    });
    if (error) {
      if (isMissingDbFeature(error) && !IS_PRODUCTION) {
        return fulfillCoinPurchase({
          userId: intent.user_id,
          packageId: intent.product_id,
          orderKey: intent.intent_key,
          reference,
          provider,
          amountPaid: amount,
          currency,
          metadata: { paymentIntentId: intent.id, verification },
        });
      }
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      balance: Number(row?.new_balance || 0),
      tokenCreditId: row?.token_credit_id || null,
      walletTransactionId: row?.wallet_transaction_id || null,
      duplicate: row?.duplicate === true,
    };
  }

  const { data, error } = await supabase.rpc('secure_fulfill_membership_payment', {
    p_intent_id: intent.id,
    p_provider: provider,
    p_provider_reference: reference,
    p_amount: Number(amount),
    p_currency: currency,
    p_verification: verification.raw || verification,
    p_event: event.raw || event,
  });
  if (error) {
    if (isMissingDbFeature(error) && !IS_PRODUCTION) {
      return activateMembershipFromPayment(intent.user_id, intent.product_id, {
        reference,
        provider,
        amountPaidUsd: amount,
        currency,
        orderKey: intent.intent_key,
        metadata: { paymentIntentId: intent.id, verification },
      });
    }
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    membershipId: row?.membership_id || null,
    duplicate: row?.duplicate === true,
  };
}

async function findPaymentIntent({ provider, providerReference, orderKey }) {
  if (!supabase) return null;

  try {
    if (providerReference) {
      const { data, error } = await supabase
        .from('payment_intents')
        .select('*')
        .eq('provider', provider)
        .eq('provider_reference', providerReference)
        .maybeSingle();
      if (error && !isMissingDbFeature(error)) throw error;
      if (data) return data;
    }

    if (orderKey) {
      const { data, error } = await supabase
        .from('payment_intents')
        .select('*')
        .eq('intent_key', orderKey)
        .maybeSingle();
      if (error && !isMissingDbFeature(error)) throw error;
      if (data) return data;
    }

    return null;
  } catch (error) {
    if (isMissingDbFeature(error)) return null;
    throw error;
  }
}

async function recordWebhookEvent({ provider, normalized, signatureValid, headers }) {
  if (!supabase) return { id: null, duplicate: false };
  const replaySeed = [
    provider,
    normalized.eventId || '',
    normalized.reference || '',
    normalized.eventType || '',
  ].join(':');
  const replayKey = crypto.createHash('sha256').update(replaySeed).digest('hex');

  const { data, error } = await supabase
    .from('webhook_events')
    .insert({
      provider,
      event_id: normalized.eventId || null,
      provider_reference: normalized.reference || null,
      event_type: normalized.eventType || 'unknown',
      signature_valid: signatureValid,
      replay_key: replayKey,
      headers,
      payload: normalized.raw || {},
    })
    .select('id')
    .maybeSingle();

  if (error?.code === '23505') return { id: null, duplicate: true };
  if (error && !isMissingDbFeature(error)) throw error;
  return { id: data?.id || null, duplicate: false };
}

async function markWebhookProcessed(id, status = 'processed', errorMessage = null) {
  if (!supabase || !id) return;
  await runOptionalPaymentQuery(
    supabase
      .from('webhook_events')
      .update({
        status,
        error_message: errorMessage,
        processed_at: new Date().toISOString(),
      })
      .eq('id', id),
    'mark webhook processed',
  );
}

async function insertPaymentTransaction({ intent, provider, reference, amount, currency, verification, event }) {
  if (!supabase) return;
  const { error } = await supabase.from('payment_transactions').insert({
    intent_id: intent.id,
    provider,
    provider_reference: reference,
    provider_transaction_id: verification.providerTransactionId || null,
    event_type: event.eventType || 'payment.verified',
    status: 'verified',
    amount,
    currency,
    verified: true,
    raw_event: event.raw || event,
    raw_verification: verification.raw || verification,
  });
  if (error?.code !== '23505' && error && !isMissingDbFeature(error)) throw error;
}

async function markIntentByReference(reference, patch = {}) {
  if (!supabase || !reference) return;
  await runOptionalPaymentQuery(
    supabase
      .from('payment_intents')
      .update({
        status: patch.status,
        metadata: patch.metadata || {},
        updated_at: new Date().toISOString(),
      })
      .eq('provider_reference', reference),
    'mark payment intent by reference',
  );
}

async function markIntentSuspicious(intent, reason, metadata = {}) {
  if (!supabase || !intent?.id) return;
  await supabase
    .from('payment_intents')
    .update({
      status: 'suspicious',
      risk_score: Math.max(Number(intent.risk_score || 0), 95),
      risk_flags: [...new Set([...(Array.isArray(intent.risk_flags) ? intent.risk_flags : []), reason])],
      updated_at: new Date().toISOString(),
    })
    .eq('id', intent.id);
  await writeFraudLog({
    userId: intent.user_id,
    intentId: intent.id,
    provider: intent.provider,
    providerReference: intent.provider_reference,
    reason,
    riskScore: 95,
    riskFlags: [reason],
    metadata,
  });
}

async function writeAudit({ intentId = null, userId = null, eventType, actorType = 'system', actorId = null, ipHash = null, message = '', metadata = {} }) {
  if (!supabase) return;
  const { error } = await supabase.from('payment_audit_logs').insert({
    intent_id: intentId,
    user_id: userId,
    event_type: eventType,
    actor_type: actorType,
    actor_id: actorId,
    ip_hash: ipHash,
    message,
    metadata,
  });
  if (error && !isMissingDbFeature(error)) console.warn('[payments] audit log failed:', error.message);
}

async function writeFraudLog({ userId = null, intentId = null, provider = null, providerReference = null, reason, riskScore = 0, riskFlags = [], metadata = {} }) {
  if (!supabase) return;
  const { error } = await supabase.from('fraud_detection_logs').insert({
    user_id: userId,
    intent_id: intentId,
    provider,
    provider_reference: providerReference,
    risk_score: riskScore,
    risk_flags: riskFlags,
    reason,
    metadata,
  });
  if (error && !isMissingDbFeature(error)) console.warn('[payments] fraud log failed:', error.message);
}

export async function expireStalePaymentIntents({ limit = 500 } = {}) {
  if (!supabase) return { expired: 0 };
  const { data, error } = await supabase
    .from('payment_intents')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .in('status', ['created', 'checkout_created', 'processing'])
    .lt('expires_at', new Date().toISOString())
    .select('id,user_id');
  if (error) {
    if (isMissingDbFeature(error)) return { expired: 0 };
    throw error;
  }
  for (const row of (data || []).slice(0, limit)) {
    await writeAudit({
      intentId: row.id,
      userId: row.user_id,
      eventType: 'payment.intent_expired',
      message: 'Payment session expired automatically',
    });
  }
  return { expired: data?.length || 0 };
}

export async function getPaymentMonitoring({ page = 1, limit = 25, search = '', statusFilter = '', methodFilter = '' } = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const from = (safePage - 1) * safeLimit;
  const to = from + safeLimit - 1;

  try {
    const [statsRes, fraudRes] = await Promise.all([
      supabase.from('payment_intents').select('amount,status,currency,provider,product_type'),
      supabase.from('fraud_detection_logs').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    ]);
    if (statsRes.error && !isMissingDbFeature(statsRes.error)) throw statsRes.error;

    let query = supabase
      .from('payment_intents')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (statusFilter) query = query.eq('status', statusFilter);
    if (methodFilter) query = query.eq('provider', methodFilter);
    if (search) {
      query = query.or(`provider_reference.ilike.%${search}%,intent_key.ilike.%${search}%,user_id.ilike.%${search}%`);
    }
    const { data, error, count } = await query;
    if (error) {
      if (isMissingDbFeature(error)) throw error;
      throw error;
    }

    const all = statsRes.data || [];
    const revenueUsd = (row) => {
      const amount = Number(row.amount || 0);
      return String(row.currency || 'USD').toUpperCase() === 'NGN' ? amount / NGN_PER_USD : amount;
    };
    const stats = {
      totalTransactions: all.length,
      totalRevenue: money(all.filter((row) => ['fulfilled', 'paid'].includes(row.status)).reduce((sum, row) => sum + revenueUsd(row), 0)),
      pending: all.filter((row) => ['created', 'checkout_created', 'processing'].includes(row.status)).length,
      failed: all.filter((row) => ['failed', 'suspicious', 'expired'].includes(row.status)).length,
      refunded: 0,
      fraudAlerts: fraudRes.count || 0,
      tokenSales: all.filter((row) => row.product_type === 'coins' && row.status === 'fulfilled').length,
      conversionRate: all.length ? Math.round((all.filter((row) => row.status === 'fulfilled').length / all.length) * 10000) / 100 : 0,
    };

    const payments = (data || []).map((row) => ({
      id: row.id,
      reference: row.provider_reference || row.intent_key,
      userId: row.user_id,
      name: `User ${String(row.user_id || '').slice(0, 8)}`,
      email: '',
      item: `${row.product_type}: ${row.product_id}`,
      amount: Number(row.amount || 0),
      method: row.provider || 'pending',
      status: row.status,
      date: row.created_at,
      riskScore: Number(row.risk_score || 0),
      riskFlags: row.risk_flags || [],
    }));

    return { payments, total: count || 0, page: safePage, limit: safeLimit, stats };
  } catch (error) {
    if (!isMissingDbFeature(error)) throw error;
    return null;
  }
}

export async function getFraudAlerts({ page = 1, limit = 25, status = 'open' } = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const from = (safePage - 1) * safeLimit;
  const to = from + safeLimit - 1;

  let query = supabase
    .from('fraud_detection_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) throw error;
  return { alerts: data || [], total: count || 0, page: safePage, limit: safeLimit };
}

export async function getWebhookEvents({ page = 1, limit = 25, provider = '', status = '' } = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const from = (safePage - 1) * safeLimit;
  const to = from + safeLimit - 1;

  let query = supabase
    .from('webhook_events')
    .select('*', { count: 'exact' })
    .order('received_at', { ascending: false })
    .range(from, to);
  if (provider) query = query.eq('provider', provider);
  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) throw error;
  return { events: data || [], total: count || 0, page: safePage, limit: safeLimit };
}

export async function getPaymentAuditTrail(intentId) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!intentId) throw new Error('intentId is required');

  const [{ data: intent, error: intentErr }, { data: audit, error: auditErr }, { data: tx, error: txErr }] = await Promise.all([
    supabase.from('payment_intents').select('*').eq('id', intentId).maybeSingle(),
    supabase.from('payment_audit_logs').select('*').eq('intent_id', intentId).order('created_at', { ascending: true }),
    supabase.from('payment_transactions').select('*').eq('intent_id', intentId).order('created_at', { ascending: true }),
  ]);

  if (intentErr) throw intentErr;
  if (auditErr) throw auditErr;
  if (txErr) throw txErr;
  if (!intent) throw new Error('Payment intent not found');

  return { intent, auditLogs: audit || [], transactions: tx || [] };
}

export async function getGatewayAnalytics({ hours = 24 } = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const since = new Date(Date.now() - Math.max(1, Number(hours) || 24) * 60 * 60 * 1000).toISOString();

  const [intentsRes, txRes, webhooksRes] = await Promise.all([
    supabase.from('payment_intents').select('provider,status,metadata').gte('created_at', since),
    supabase.from('payment_transactions').select('provider,status,amount,currency').gte('created_at', since),
    supabase.from('webhook_events').select('provider,status').gte('received_at', since),
  ]);

  if (intentsRes.error) throw intentsRes.error;
  if (txRes.error) throw txRes.error;
  if (webhooksRes.error) throw webhooksRes.error;

  const byProvider = {};
  const ensure = (provider) => {
    const key = String(provider || 'unknown').toLowerCase();
    if (!byProvider[key]) {
      byProvider[key] = {
        provider: key,
        attempts: 0,
        fulfilled: 0,
        failed: 0,
        fallbackUsed: 0,
        retries: 0,
        revenue: 0,
      };
    }
    return byProvider[key];
  };

  for (const row of intentsRes.data || []) {
    const bucket = ensure(row.provider);
    bucket.attempts += 1;
    if (row.status === 'fulfilled') bucket.fulfilled += 1;
    if (row.status === 'failed') bucket.failed += 1;
    const meta = row.metadata || {};
    if (meta.fallbackUsed) bucket.fallbackUsed += 1;
    bucket.retries += Number(meta.retryCount || 0);
  }

  for (const row of txRes.data || []) {
    const bucket = ensure(row.provider);
    if (row.status === 'verified' || row.status === 'completed') {
      bucket.revenue += Number(row.amount || 0);
    }
  }

  const webhookFailures = (webhooksRes.data || []).filter((row) => row.status === 'failed');

  return {
    since,
    providers: Object.values(byProvider),
    webhookFailures: webhookFailures.length,
    verificationFailures: webhookFailures.length,
    totalAttempts: (intentsRes.data || []).length,
    totalTransactions: (txRes.data || []).length,
  };
}

export async function getPaymentReconciliationReport({ hours = 24 } = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const since = new Date(Date.now() - Math.max(1, Number(hours) || 24) * 60 * 60 * 1000).toISOString();

  const [intentsRes, txRes, webhooksRes, fraudRes] = await Promise.all([
    supabase.from('payment_intents').select('id,status,provider_reference').gte('created_at', since),
    supabase.from('payment_transactions').select('intent_id,provider_reference,status').gte('created_at', since),
    supabase.from('webhook_events').select('id,status,provider').gte('received_at', since),
    supabase.from('fraud_detection_logs').select('id', { count: 'exact', head: true }).eq('status', 'open'),
  ]);

  if (intentsRes.error) throw intentsRes.error;
  if (txRes.error) throw txRes.error;
  if (webhooksRes.error) throw webhooksRes.error;

  const fulfilled = (intentsRes.data || []).filter((row) => row.status === 'fulfilled');
  const txIntentIds = new Set((txRes.data || []).map((row) => row.intent_id).filter(Boolean));
  const orphans = fulfilled.filter((row) => !txIntentIds.has(row.id));

  return {
    since,
    intentsTotal: intentsRes.data?.length || 0,
    fulfilledCount: fulfilled.length,
    transactionsCount: txRes.data?.length || 0,
    orphanFulfillments: orphans,
    webhookEvents: {
      total: webhooksRes.data?.length || 0,
      failed: (webhooksRes.data || []).filter((row) => row.status === 'failed').length,
      duplicate: (webhooksRes.data || []).filter((row) => row.status === 'duplicate').length,
    },
    openFraudAlerts: fraudRes.count || 0,
  };
}

export async function refreshAndFulfillPaymentIntent({ reference, orderKey = null, userId = null } = {}) {
  const current = await getPaymentIntentStatus({ reference, orderKey, userId });
  if (!current) return null;

  if (current.status === 'fulfilled') {
    return {
      verified: true,
      fulfilled: true,
      duplicate: true,
      payment: current,
      providerStatus: { status: 'fulfilled' },
    };
  }

  if (!current.provider) {
    return {
      verified: false,
      fulfilled: false,
      payment: current,
      providerStatus: { error: 'Payment provider is not attached to this intent yet.' },
    };
  }

  let verified;
  try {
    verified = await verifyProviderTransaction(current.provider, {
      reference: current.reference || reference,
      orderKey: current.orderKey || orderKey || reference,
    });
  } catch (error) {
    logPaymentEvent('warn', 'payment.refresh_verification_pending', {
      provider: current.provider,
      reference: current.reference || reference,
      orderKey: current.orderKey || orderKey || null,
      error: error?.message,
    });
    return {
      verified: false,
      fulfilled: false,
      payment: current,
      providerStatus: {
        status: 'pending_or_failed',
        error: error?.message || 'Provider verification is not complete yet.',
      },
    };
  }

  const fulfillment = await fulfillVerifiedProviderPayment({
    provider: current.provider,
    verified,
    normalized: {
      reference: current.reference || reference,
      orderKey: current.orderKey || orderKey || verified.orderKey || null,
      eventType: 'payment.callback_refresh',
      raw: { source: 'payment_verify_refresh', reference, orderKey },
    },
    source: 'callback_refresh',
  });

  const latest = await getPaymentIntentStatus({
    reference: current.orderKey || current.reference || reference,
    userId,
  });

  return {
    verified: latest?.status === 'fulfilled',
    fulfilled: fulfillment.fulfilled === true,
    duplicate: fulfillment.duplicate === true,
    suspicious: fulfillment.suspicious === true,
    error: fulfillment.error || null,
    payment: latest || current,
    providerStatus: {
      status: verified.status,
      amount: verified.amount,
      currency: verified.currency,
      reference: verified.reference,
      orderKey: verified.orderKey,
    },
    result: fulfillment.result || null,
  };
}

export async function getPaymentIntentStatus({ reference, orderKey, userId } = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!reference && !orderKey) throw new Error('reference or orderKey is required');

  try {
    const selectColumns = 'id,intent_key,provider,provider_reference,product_type,product_id,amount,currency,status,expires_at,fulfilled_at,created_at,updated_at';
    let row = null;
    const candidates = [reference, orderKey].filter(Boolean);
    for (const candidate of [...new Set(candidates)]) {
      for (const field of ['provider_reference', 'intent_key']) {
        let query = supabase
          .from('payment_intents')
          .select(selectColumns)
          .eq(field, candidate)
          .limit(1);
        if (userId) query = query.eq('user_id', userId);
        const { data, error } = await query;
        if (error) {
          if (isMissingDbFeature(error)) return null;
          throw error;
        }
        row = data?.[0] || null;
        if (row) break;
      }
      if (row) break;
    }

    if (!row) return null;
    return {
      id: row.id,
      orderKey: row.intent_key,
      provider: row.provider,
      reference: row.provider_reference,
      productType: row.product_type,
      productId: row.product_id,
      amount: Number(row.amount || 0),
      currency: row.currency,
      status: row.status,
      expired: row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false,
      expiresAt: row.expires_at,
      fulfilledAt: row.fulfilled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    if (isMissingDbFeature(error)) return null;
    throw error;
  }
}
