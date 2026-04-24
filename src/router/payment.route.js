/**
 * payment.route.js
 *
 * Mounted at /api/payments in index.js.
 *
 * Public
 *   GET  /api/payments/plans              — list active membership plans
 *
 * Authenticated
 *   POST /api/payments/checkout           — create checkout session via payment service
 *   GET  /api/payments/membership         — current user's plan + coin balance
 *
 * Webhooks (no auth — verified by HMAC signature)
 *   POST /api/payments/webhooks/paystack  — Paystack charge.success
 *   POST /api/payments/webhooks/monnify   — Monnify SUCCESSFUL_TRANSACTION
 *
 * Checkout creation is fully delegated to the C# payment service via
 * paymentServiceClient.  Only webhook signature verification and plan-
 * activation logic live here.
 */

import express from 'express';
import crypto  from 'crypto';
import { requireAuth } from '../middleware/authFirebase.js';
import {
  getMembershipPlans,
  getUserMembership,
  activatePlan,
} from '../controller/membership.controller.js';
import { addTokens } from '../controller/tokens.controller.js';
import { createCheckout as createPaymentServiceCheckout } from '../services/paymentServiceClient.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Webhook verification keys
// These are only needed to verify HMAC signatures on incoming webhook calls
// and to re-query the payment providers for server-side confirmation.
// Checkout creation credentials live exclusively in the payment service.
// ---------------------------------------------------------------------------
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const MONNIFY_SECRET_KEY  = process.env.MONNIFY_SECRET_KEY  || '';

// ---------------------------------------------------------------------------
// GET /api/payments/plans
// ---------------------------------------------------------------------------
router.get('/plans', async (_req, res) => {
  try {
    const plans = await getMembershipPlans();
    res.json({ ok: true, data: plans });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/payments/membership  (requires auth)
// ---------------------------------------------------------------------------
router.get('/membership', requireAuth, async (req, res) => {
  try {
    const membership = await getUserMembership(req.uid);
    res.json({ ok: true, data: membership });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/payments/checkout  (requires auth)
//
// Delegates to the C# payment service via PAYMENT_SERVICE_URL.
// Body: { planId, countryCode, customerEmail, customerName }
// ---------------------------------------------------------------------------
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const {
      planId,
      countryCode,
      customerEmail = '',
      customerName  = 'Member',
    } = req.body;

    if (!planId)      return res.status(400).json({ ok: false, error: 'planId is required' });
    if (!countryCode) return res.status(400).json({ ok: false, error: 'countryCode is required' });

    // Fetch plan to get correct price / currency
    const plans = await getMembershipPlans();
    const plan  = plans.find(p => p.id === planId);
    if (!plan) return res.status(400).json({ ok: false, error: `Unknown plan: ${planId}` });

    const isNigeria = countryCode.trim().toUpperCase() === 'NG';
    const amount    = isNigeria ? Number(plan.price_ngn) : Number(plan.price_usd);
    const currency  = isNigeria ? 'NGN' : 'USD';

    // orderId encodes userId + planId so webhooks can recover them.
    // Firebase UIDs are 28 alphanumeric chars (no underscores), so the first
    // segment is always the userId.  planId may contain underscores (coins_30).
    const orderId = `${req.uid}_${planId}_${Date.now()}`;

    const paymentResp = await createPaymentServiceCheckout({
      orderId,
      userId:        req.uid,
      planId,
      countryCode:   countryCode.trim().toUpperCase(),
      currency,
      amount,
      productName:   plan.name,
      customerEmail,
      customerName,
    });

    res.json({
      ok:          true,
      provider:    paymentResp.provider,
      checkoutUrl: paymentResp.checkoutUrl,
      reference:   paymentResp.reference,
    });
  } catch (err) {
    console.error('[payment] checkout error:', err.message);
    // Surface service-down errors as 503 so the frontend can show a friendly message
    const status = /unreachable|timed out/i.test(err.message) ? 503 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/payments/webhooks/paystack
//
// Paystack signs the raw JSON body with HMAC-SHA512 using the secret key.
// Signature arrives in the `x-paystack-signature` header.
// ---------------------------------------------------------------------------
router.post('/webhooks/paystack', async (req, res) => {
  const receivedSig = req.headers['x-paystack-signature'] ?? '';

  if (PAYSTACK_SECRET_KEY) {
    const rawPayload = req.rawBody ?? JSON.stringify(req.body);
    const computedSig = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(rawPayload)
      .digest('hex');

    if (computedSig !== receivedSig) {
      console.error('[paystack-webhook] Signature mismatch — request rejected');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  } else {
    console.warn('[paystack-webhook] PAYSTACK_SECRET_KEY not set — skipping verification (dev only)');
  }

  const { event, data } = req.body ?? {};

  if (event === 'charge.success' && data?.status === 'success') {
    const meta      = data.metadata ?? {};
    const reference = data.reference;
    const userId    = meta.user_id  ?? _parseOrderId(meta.order_id)?.userId;
    const planId    = meta.plan_id  ?? _parseOrderId(meta.order_id)?.planId;
    const currency  = (data.currency ?? 'NGN').toUpperCase();
    const amountUsd = currency === 'USD'
      ? (data.amount ?? 0) / 100
      : (data.amount ?? 0) / 100 / 1550; // rough NGN→USD; replace with live rate

    if (!userId || !planId) {
      console.error('[paystack-webhook] Missing userId or planId in metadata', meta);
      return res.status(200).end(); // 200 so Paystack stops retrying
    }

    try {
      await _verifyPaystackTransaction(reference);
      if (planId.startsWith('tokens_')) {
        const tokenAmount = _parseTokenAmount(planId);
        await addTokens(userId, tokenAmount, { reference, paymentAmount: amountUsd, currency: 'USD' });
        console.log(`[paystack-webhook] ${tokenAmount} tokens added for user "${userId}"`);
      } else {
        await activatePlan(userId, planId, { reference, provider: 'paystack', amountPaidUsd: amountUsd });
        console.log(`[paystack-webhook] Plan "${planId}" activated for user "${userId}"`);
      }
    } catch (err) {
      console.error('[paystack-webhook] fulfillment failed:', err.message);
    }
  }

  res.status(200).json({ received: true });
});

// ---------------------------------------------------------------------------
// POST /api/payments/webhooks/monnify
//
// Monnify sends a POST with a JSON body.
// Signature is HMAC-SHA512 of the serialised payload using the secret key.
// Per Monnify docs: always re-query transaction status before crediting.
// ---------------------------------------------------------------------------
router.post('/webhooks/monnify', express.json(), async (req, res) => {
  const receivedHash = req.headers['monnify-signature'] ?? '';

  if (MONNIFY_SECRET_KEY && receivedHash) {
    const rawPayload = req.rawBody ?? JSON.stringify(req.body);
    const computedHash = crypto
      .createHmac('sha512', MONNIFY_SECRET_KEY)
      .update(rawPayload)
      .digest('hex');

    const computedBuf = Buffer.from(computedHash, 'hex');
    const receivedBuf = Buffer.from(receivedHash.toLowerCase(), 'hex');
    const sigMismatch =
      computedBuf.length !== receivedBuf.length ||
      !crypto.timingSafeEqual(computedBuf, receivedBuf);

    if (sigMismatch) {
      console.error('[monnify-webhook] Signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  } else if (!MONNIFY_SECRET_KEY) {
    console.warn('[monnify-webhook] MONNIFY_SECRET_KEY not set — skipping verification (dev only)');
  }

  const { eventType, eventData } = req.body ?? {};

  if (eventType === 'SUCCESSFUL_TRANSACTION') {
    const txRef    = eventData?.transactionReference;
    const payRef   = eventData?.paymentReference;
    const txStatus = eventData?.paymentStatus;
    const metaData = eventData?.metaData ?? {};

    if (txStatus !== 'PAID') {
      console.log('[monnify-webhook] Non-PAID status received:', txStatus);
      return res.status(200).json({ received: true });
    }

    try {
      await _verifyMonnifyTransaction(txRef);

      const userId    = metaData?.userId ?? _parseOrderId(payRef)?.userId;
      const planId    = metaData?.planId ?? _parseOrderId(payRef)?.planId;
      const amountUsd = eventData?.amountPaid
        ? Number(eventData.amountPaid) / 1550 // rough NGN→USD; replace with live rate
        : undefined;

      if (!userId || !planId) {
        console.error('[monnify-webhook] Missing userId or planId in metaData');
        return res.status(200).end();
      }

      if (planId.startsWith('tokens_')) {
        const tokenAmount = _parseTokenAmount(planId);
        await addTokens(userId, tokenAmount, { reference: txRef ?? payRef, paymentAmount: amountUsd, currency: 'NGN' });
        console.log(`[monnify-webhook] ${tokenAmount} tokens added for user "${userId}"`);
      } else {
        await activatePlan(userId, planId, { reference: txRef ?? payRef, provider: 'monnify', amountPaidUsd: amountUsd });
        console.log(`[monnify-webhook] Plan "${planId}" activated for user "${userId}"`);
      }
    } catch (err) {
      console.error('[monnify-webhook] activatePlan failed:', err.message);
    }
  }

  res.status(200).json({ received: true });
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse orderId format: "{userId}_{planId}_{timestamp}"
 *
 * Firebase UIDs are 28 alphanumeric characters (no underscores).
 * Plan IDs may contain underscores (e.g. "coins_30", "coins_120").
 * The timestamp is always the last numeric segment.
 */
/** Extract numeric token amount from planId like "tokens_30" → 30 */
function _parseTokenAmount(planId) {
  const n = parseInt((planId ?? '').replace('tokens_', ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function _parseOrderId(orderId) {
  if (!orderId) return null;
  const parts = orderId.split('_');
  if (parts.length < 3) return null;
  const userId = parts[0];
  const planId = parts.slice(1, -1).join('_');
  if (!userId || !planId) return null;
  return { userId, planId };
}

/**
 * Re-query Monnify transaction status server-side.
 * Throws if the transaction is not PAID.
 */
async function _verifyMonnifyTransaction(transactionReference) {
  const apiKey = process.env.MONNIFY_API_KEY   ?? '';
  const secret = process.env.MONNIFY_SECRET_KEY ?? '';
  const base   = process.env.MONNIFY_BASE_URL   ?? 'https://sandbox.monnify.com';

  if (!apiKey || !secret) {
    console.warn('[monnify] Skipping re-query — credentials not configured');
    return;
  }

  const credentials = Buffer.from(`${apiKey}:${secret}`).toString('base64');

  const authRes  = await fetch(`${base}/api/v1/auth/login`, {
    method:  'POST',
    headers: { Authorization: `Basic ${credentials}` },
  });
  const authData = await authRes.json();
  const token    = authData?.responseBody?.accessToken;
  if (!token) throw new Error('Monnify re-query auth failed');

  const txRes  = await fetch(
    `${base}/api/v2/transactions/${encodeURIComponent(transactionReference)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const txData = await txRes.json();
  const status = txData?.responseBody?.paymentStatus;

  if (status !== 'PAID') {
    throw new Error(`Monnify transaction not PAID (status: ${status})`);
  }
}

/**
 * Re-verify a Paystack transaction server-side before crediting.
 * Throws if status is not 'success'.
 */
async function _verifyPaystackTransaction(reference) {
  if (!PAYSTACK_SECRET_KEY) {
    console.warn('[paystack] Skipping re-verify — PAYSTACK_SECRET_KEY not configured');
    return;
  }

  const res  = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );
  const body = await res.json();

  if (!body?.status || body?.data?.status !== 'success') {
    throw new Error(
      `Paystack transaction not successful (status: ${body?.data?.status ?? 'unknown'})`
    );
  }
}

export default router;
