import crypto from 'crypto';
import { getRawRequestBody } from '../middleware/qstashSignature.js';

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const FLUTTERWAVE_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY || '';
const FLUTTERWAVE_WEBHOOK_HASH = process.env.FLUTTERWAVE_WEBHOOK_HASH || process.env.FLW_SECRET_HASH || '';
const STRIPE_TOLERANCE_SECONDS = Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS || 300);

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hmacHex(algorithm, secret, payload) {
  return crypto.createHmac(algorithm, secret).update(payload).digest('hex');
}

function requireSecret(secret, name) {
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error(`${name} is required in production`);
  }
  return Boolean(secret);
}

function missingSecretResult(name) {
  if (process.env.NODE_ENV === 'production') {
    return { valid: false, skipped: false, reason: `${name}_missing` };
  }
  return { valid: true, skipped: true, reason: `${name}_missing_dev_skip` };
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = getRawRequestBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function verifyWebhookSignature(provider, req) {
  const rawBody = getRawRequestBody(req);
  const normalized = String(provider || '').toLowerCase();

  if (normalized === 'paystack') {
    const signature = req.get('x-paystack-signature') || '';
    if (!requireSecret(PAYSTACK_SECRET_KEY, 'PAYSTACK_SECRET_KEY')) {
      return missingSecretResult('PAYSTACK_SECRET_KEY');
    }
    const computed = hmacHex('sha512', PAYSTACK_SECRET_KEY, rawBody);
    return { valid: timingSafeEqualText(computed, signature), skipped: false };
  }

  if (normalized === 'stripe') {
    const signature = req.get('stripe-signature') || '';
    if (!requireSecret(STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET')) {
      return missingSecretResult('STRIPE_WEBHOOK_SECRET');
    }
    const parts = Object.fromEntries(signature.split(',').map((item) => {
      const [key, ...rest] = item.split('=');
      return [key, rest.join('=')];
    }));
    const timestamp = Number(parts.t || 0);
    if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > STRIPE_TOLERANCE_SECONDS) {
      return { valid: false, skipped: false, reason: 'timestamp_out_of_range' };
    }
    const computed = hmacHex('sha256', STRIPE_WEBHOOK_SECRET, `${timestamp}.${rawBody}`);
    const signatures = signature.split(',').filter((item) => item.startsWith('v1=')).map((item) => item.slice(3));
    return { valid: signatures.some((value) => timingSafeEqualText(computed, value)), skipped: false };
  }

  if (normalized === 'flutterwave') {
    const signature = req.get('verif-hash') || req.get('flutterwave-signature') || '';
    if (!requireSecret(FLUTTERWAVE_WEBHOOK_HASH, 'FLUTTERWAVE_WEBHOOK_HASH')) {
      return missingSecretResult('FLUTTERWAVE_WEBHOOK_HASH');
    }
    const hmacBase64 = crypto
      .createHmac('sha256', FLUTTERWAVE_WEBHOOK_HASH)
      .update(rawBody)
      .digest('base64');
    const hmacHex = hmacHexDigest('sha256', FLUTTERWAVE_WEBHOOK_HASH, rawBody);

    // Flutterwave's newer webhook docs use flutterwave-signature as a
    // HMAC-SHA256 digest of the raw body. Older integrations may still send
    // verif-hash as the dashboard secret itself, so keep that fallback to avoid
    // breaking existing configured webhooks during rotation.
    return {
      valid: (
        timingSafeEqualText(hmacBase64, signature) ||
        timingSafeEqualText(hmacHex, signature) ||
        timingSafeEqualText(FLUTTERWAVE_WEBHOOK_HASH, signature)
      ),
      skipped: false,
    };
  }

  return { valid: false, skipped: false, reason: 'unknown_provider' };
}

function hmacHexDigest(algorithm, secret, payload) {
  return crypto.createHmac(algorithm, secret).update(payload).digest('hex');
}

export function normalizeWebhookPayload(provider, req) {
  const body = parseJsonBody(req);
  const normalized = String(provider || '').toLowerCase();

  if (normalized === 'paystack') {
    const data = body.data || {};
    const meta = data.metadata || {};
    return {
      provider: 'paystack',
      eventId: data.id ? `paystack:${data.id}` : data.reference,
      eventType: body.event || 'unknown',
      successful: body.event === 'charge.success' && data.status === 'success',
      failed: data.status && data.status !== 'success',
      reference: data.reference,
      orderKey: meta.order_id || meta.orderId || null,
      productType: meta.product_type || meta.productType,
      productId: meta.product_id || meta.productId || meta.plan_id || meta.planId,
      userId: meta.user_id || meta.userId,
      amount: Number(data.amount || 0) / 100,
      currency: String(data.currency || 'NGN').toUpperCase(),
      metadata: meta,
      raw: body,
    };
  }

  if (normalized === 'stripe') {
    const object = body.data?.object || {};
    const metadata = object.metadata || {};
    const reference = object.payment_intent || object.id;
    return {
      provider: 'stripe',
      eventId: body.id,
      eventType: body.type || 'unknown',
      successful: ['checkout.session.completed', 'payment_intent.succeeded'].includes(body.type),
      failed: ['payment_intent.payment_failed', 'checkout.session.expired'].includes(body.type),
      reference,
      orderKey: metadata.orderId || metadata.order_id || object.client_reference_id || null,
      productType: metadata.productType || metadata.product_type,
      productId: metadata.productId || metadata.product_id,
      userId: metadata.userId || metadata.user_id,
      amount: object.amount_total != null ? Number(object.amount_total) / 100 : (object.amount_received != null ? Number(object.amount_received) / 100 : undefined),
      currency: String(object.currency || 'USD').toUpperCase(),
      metadata,
      raw: body,
    };
  }

  if (normalized === 'flutterwave') {
    const data = body.data || body;
    const meta = data.meta || data.metadata || {};
    const status = String(data.status || '').toLowerCase();
    const eventType = body.event || body['event.type'] || 'unknown';
    const successful = status === 'successful' || eventType === 'charge.completed';
    const failed = ['failed', 'cancelled'].includes(status)
      || ['charge.failed', 'charge.cancelled'].includes(eventType);
    const pending = status === 'pending' || eventType === 'charge.pending';
    return {
      provider: 'flutterwave',
      eventId: data.id ? `flutterwave:${data.id}` : (data.tx_ref ? `flutterwave:tx:${data.tx_ref}` : eventType),
      eventType,
      successful,
      failed: failed && !pending,
      pending,
      reference: data.id ? String(data.id) : (data.flw_ref || data.tx_ref || null),
      orderKey: data.tx_ref || meta.orderId || meta.order_id || null,
      productType: meta.productType || meta.product_type,
      productId: meta.productId || meta.product_id,
      userId: meta.userId || meta.user_id,
      amount: data.amount == null ? undefined : Number(data.amount),
      currency: String(data.currency || 'USD').toUpperCase(),
      metadata: meta,
      raw: body,
    };
  }

  return { provider: normalized, eventType: 'unknown', successful: false, failed: false, raw: body };
}

export async function verifyProviderTransaction(provider, normalized) {
  const name = String(provider || '').toLowerCase();
  if (name === 'paystack') return verifyPaystack(normalized.reference);
  if (name === 'stripe') return verifyStripe(normalized.reference);
  if (name === 'flutterwave') return verifyFlutterwave(normalized.reference, normalized.orderKey);
  throw new Error(`Unsupported payment provider: ${provider}`);
}

async function verifyPaystack(reference) {
  if (!PAYSTACK_SECRET_KEY || !reference) throw new Error('Paystack verification is not configured');
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
  });
  const body = await res.json().catch(() => ({}));
  const data = body.data || {};
  if (!body.status || data.status !== 'success') {
    throw new Error(`Paystack transaction not successful (status: ${data.status ?? 'unknown'})`);
  }
  const meta = data.metadata || {};
  return {
    provider: 'paystack',
    providerTransactionId: data.id ? String(data.id) : null,
    reference: data.reference,
    amount: Number(data.amount || 0) / 100,
    currency: String(data.currency || 'NGN').toUpperCase(),
    status: data.status,
    orderKey: meta.order_id || meta.orderId || null,
    userId: meta.user_id || meta.userId,
    productType: meta.product_type || meta.productType,
    productId: meta.product_id || meta.productId || meta.plan_id || meta.planId,
    raw: body,
  };
}

async function verifyStripe(reference) {
  if (!STRIPE_SECRET_KEY || !reference) throw new Error('Stripe verification is not configured');
  const id = String(reference).startsWith('pi_') ? reference : String(reference);
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'succeeded') {
    throw new Error(`Stripe payment intent not succeeded (status: ${body.status ?? res.status})`);
  }
  const meta = body.metadata || {};
  return {
    provider: 'stripe',
    providerTransactionId: body.id,
    reference: body.id,
    amount: Number(body.amount_received || 0) / 100,
    currency: String(body.currency || 'USD').toUpperCase(),
    status: body.status,
    orderKey: meta.orderId || meta.order_id || null,
    userId: meta.userId || meta.user_id,
    productType: meta.productType || meta.product_type,
    productId: meta.productId || meta.product_id,
    raw: body,
  };
}

async function verifyFlutterwave(reference, orderKey = null) {
  if (!FLUTTERWAVE_SECRET_KEY) throw new Error('Flutterwave verification is not configured');

  const tryVerify = async (url) => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${FLUTTERWAVE_SECRET_KEY}` },
    });
    const body = await res.json().catch(() => ({}));
    return { res, body, data: body.data || {} };
  };

  let result = null;
  if (reference && /^\d+$/.test(String(reference))) {
    result = await tryVerify(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(reference)}/verify`);
  }
  if ((!result || result.body.status !== 'success') && orderKey) {
    result = await tryVerify(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(orderKey)}`);
  }
  if ((!result || result.body.status !== 'success') && reference && !/^\d+$/.test(String(reference))) {
    result = await tryVerify(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
  }

  if (!result) throw new Error('Flutterwave verification reference is required');

  const { body, data } = result;
  const status = String(data.status || '').toLowerCase();
  if (body.status !== 'success' || status !== 'successful') {
    throw new Error(`Flutterwave transaction not successful (status: ${data.status ?? body.status ?? 'unknown'})`);
  }

  const meta = data.meta || data.metadata || {};
  return {
    provider: 'flutterwave',
    providerTransactionId: data.id ? String(data.id) : null,
    reference: data.id ? String(data.id) : data.tx_ref,
    amount: Number(data.amount || 0),
    currency: String(data.currency || 'USD').toUpperCase(),
    status: data.status,
    orderKey: data.tx_ref || meta.orderId || meta.order_id || orderKey || null,
    userId: meta.userId || meta.user_id,
    productType: meta.productType || meta.product_type,
    productId: meta.productId || meta.product_id,
    raw: body,
  };
}
