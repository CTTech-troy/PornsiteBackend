/**
 * payment.route.js
 *
 * Mounted at /api/payments in index.js.
 *
 * Public
 *   GET  /api/payments/plans              — list active membership plans
 *
 * Authenticated
 *   POST /api/payments/checkout           — create Paystack / Monnify checkout session
 *   GET  /api/payments/membership         — current user's plan + coin balance
 *
 * Webhooks (no auth — verified by signature)
 *   POST /api/payments/webhooks/paystack  — Paystack charge.success
 *   POST /api/payments/webhooks/monnify   — Monnify SUCCESSFUL_TRANSACTION
 */

import express from 'express';
import crypto  from 'crypto';
import { requireAuth } from '../middleware/authFirebase.js';
import {
  getMembershipPlans,
  getUserMembership,
  activatePlan,
} from '../controller/membership.controller.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PAYSTACK_SECRET_KEY  = process.env.PAYSTACK_SECRET_KEY  || '';
const MONNIFY_API_KEY      = process.env.MONNIFY_API_KEY      || '';
const MONNIFY_SECRET_KEY   = process.env.MONNIFY_SECRET_KEY   || '';
const MONNIFY_BASE_URL     = process.env.MONNIFY_BASE_URL     || 'https://sandbox.monnify.com';
const MONNIFY_CONTRACT     = process.env.MONNIFY_CONTRACT_CODE || process.env.MONNIFY_CONTRACT || '';

// Front-end callback URLs (set these in your .env)
const PAYSTACK_CALLBACK    = process.env.PAYSTACK_CALLBACK_URL || 'http://localhost:5173/payment/success';
const MONNIFY_REDIRECT     = process.env.MONNIFY_REDIRECT_URL  || 'http://localhost:5173/payment/return';

// ---------------------------------------------------------------------------
// Helper — initiate a Paystack transaction
// Returns { checkoutUrl, reference, provider: 'paystack' }
// ---------------------------------------------------------------------------
async function paystackInitialize({ reference, email, amount, currency, metadata }) {
  if (!PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY not configured');

  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
    },
    body: JSON.stringify({
      reference,
      email:        email || 'guest@letstream.tv',
      amount:       Math.round(amount * 100), // kobo / cents
      currency,
      callback_url: PAYSTACK_CALLBACK,
      metadata,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.status) {
    throw new Error(body?.message ?? `Paystack error ${res.status}`);
  }

  return {
    checkoutUrl: body.data.authorization_url,
    reference:   body.data.reference,
    provider:    'paystack',
  };
}

// ---------------------------------------------------------------------------
// Helper — initiate a Monnify transaction
// Returns { checkoutUrl, reference, provider: 'monnify' }
// ---------------------------------------------------------------------------
async function monnifyInitialize({ reference, email, name, amount, currency, description }) {
  if (!MONNIFY_API_KEY || !MONNIFY_SECRET_KEY) throw new Error('Monnify credentials not configured');

  // 1. Get bearer token
  const creds   = Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET_KEY}`).toString('base64');
  const authRes = await fetch(`${MONNIFY_BASE_URL}/api/v1/auth/login`, {
    method:  'POST',
    headers: { Authorization: `Basic ${creds}` },
    signal:  AbortSignal.timeout(10_000),
  });
  const authData = await authRes.json().catch(() => ({}));
  const token    = authData?.responseBody?.accessToken;
  if (!token) throw new Error('Monnify authentication failed');

  // 2. Init transaction
  const txRes = await fetch(`${MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      amount,
      customerName:    name  || 'Member',
      customerEmail:   email || 'guest@letstream.tv',
      paymentReference: reference,
      paymentDescription: description,
      currencyCode:    currency,
      contractCode:    MONNIFY_CONTRACT,
      redirectUrl:     MONNIFY_REDIRECT,
      paymentMethods:  ['CARD', 'ACCOUNT_TRANSFER'],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const txData = await txRes.json().catch(() => ({}));
  if (!txRes.ok || txData?.requestSuccessful === false) {
    throw new Error(txData?.responseMessage ?? `Monnify error ${txRes.status}`);
  }

  return {
    checkoutUrl: txData.responseBody.checkoutUrl,
    reference:   txData.responseBody.paymentReference,
    provider:    'monnify',
  };
}

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
    const membership = await getUserMembership(req.uid); // eslint-disable-line no-await-in-loop
    res.json({ ok: true, data: membership });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/payments/checkout  (requires auth)
//
// Body: { planId, countryCode, customerEmail, customerName, customerPhone }
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

    // Reference encodes userId + planId so webhooks can recover them without a DB lookup
    const reference = `${req.uid}:${planId}:${Date.now()}`;

    let paymentResp;

    if (isNigeria && MONNIFY_API_KEY) {
      // Nigerian users → Monnify
      paymentResp = await monnifyInitialize({
        reference,
        email:       customerEmail,
        name:        customerName,
        amount,
        currency,
        description: plan.name,
      });
    } else {
      // Everyone else → Paystack (also works for NGN)
      paymentResp = await paystackInitialize({
        reference,
        email:    customerEmail,
        amount,
        currency,
        metadata: {
          user_id:  req.uid,
          plan_id:  planId,
          order_id: reference,
        },
      });
    }

    res.json({
      ok:          true,
      provider:    paymentResp.provider,
      checkoutUrl: paymentResp.checkoutUrl,
      reference:   paymentResp.reference,
    });
  } catch (err) {
    console.error('[payment] checkout error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/payments/webhooks/paystack
//
// Paystack signs the raw JSON body with HMAC-SHA512 using the secret key.
// Signature arrives in the `x-paystack-signature` header.
// ---------------------------------------------------------------------------
router.post('/webhooks/paystack', express.json(), async (req, res) => {
  // --- Signature verification ---
  const receivedSig = req.headers['x-paystack-signature'] ?? '';

  if (PAYSTACK_SECRET_KEY) {
    const computedSig = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
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
    // orderId format: "{userId}:{planId}:{timestamp}" — also in metadata directly
    const userId    = meta.user_id  ?? _parseOrderId(meta.order_id)?.userId;
    const planId    = meta.plan_id  ?? _parseOrderId(meta.order_id)?.planId;
    // amount is in smallest unit (kobo / cents) — convert to USD for record keeping
    const currency  = (data.currency ?? 'NGN').toUpperCase();
    const amountUsd = currency === 'USD'
      ? (data.amount ?? 0) / 100
      : (data.amount ?? 0) / 100 / 1550; // rough NGN→USD; replace with live rate

    if (!userId || !planId) {
      console.error('[paystack-webhook] Missing userId or planId in metadata', meta);
      return res.status(200).end(); // 200 so Paystack stops retrying
    }

    try {
      // Re-verify server-side before crediting
      await _verifyPaystackTransaction(reference);

      await activatePlan(userId, planId, {
        reference,
        provider:     'paystack',
        amountPaidUsd: amountUsd,
      });

      console.log(`[paystack-webhook] Plan "${planId}" activated for user "${userId}"`);
    } catch (err) {
      console.error('[paystack-webhook] activatePlan failed:', err.message);
    }
  }

  res.status(200).json({ received: true });
});

// ---------------------------------------------------------------------------
// POST /api/payments/webhooks/monnify
//
// Monnify sends a POST with a JSON body.
// Signature is HMAC-SHA512 of the serialized payload using the Monnify secret key.
// Per Monnify docs: always re-query transaction status before crediting the user.
// ---------------------------------------------------------------------------
router.post('/webhooks/monnify', express.json(), async (req, res) => {
  // --- Signature verification ---
  const receivedHash = req.headers['monnify-signature'] ?? '';

  if (MONNIFY_SECRET_KEY && receivedHash) {
    const computedHash = crypto
      .createHmac('sha512', MONNIFY_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (!crypto.timingSafeEqual(
      Buffer.from(computedHash, 'hex'),
      Buffer.from(receivedHash.toLowerCase(), 'hex')
    )) {
      console.error('[monnify-webhook] Signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  } else if (!MONNIFY_SECRET_KEY) {
    console.warn('[monnify-webhook] MONNIFY_SECRET_KEY not set — skipping verification (dev only)');
  }

  const { eventType, eventData } = req.body ?? {};

  if (eventType === 'SUCCESSFUL_TRANSACTION') {
    const txRef     = eventData?.transactionReference;
    const payRef    = eventData?.paymentReference;   // This is the paymentReference we sent
    const txStatus  = eventData?.paymentStatus;
    const metaData  = eventData?.metaData ?? {};

    if (txStatus !== 'PAID') {
      console.log('[monnify-webhook] Non-PAID status received:', txStatus);
      return res.status(200).json({ received: true });
    }

    try {
      // Re-query transaction server-side before activating (Monnify recommendation)
      await _verifyMonnifyTransaction(txRef);

      const userId    = metaData?.userId ?? _parseOrderId(payRef)?.userId;
      const planId    = metaData?.planId ?? _parseOrderId(payRef)?.planId;
      const amountUsd = eventData?.amountPaid
        ? Number(eventData.amountPaid) / 1550   // rough NGN→USD conversion; replace with live rate
        : undefined;

      if (!userId || !planId) {
        console.error('[monnify-webhook] Missing userId or planId in metaData');
        return res.status(200).end();
      }

      await activatePlan(userId, planId, {
        reference:    txRef ?? payRef,
        provider:     'monnify',
        amountPaidUsd: amountUsd,
      });

      console.log(`[monnify-webhook] Plan "${planId}" activated for user "${userId}"`);
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
 * Parse orderId format: "{userId}:{planId}:{timestamp}"
 */
function _parseOrderId(orderId) {
  if (!orderId) return null;
  const parts = orderId.split(':');
  if (parts.length < 2) return null;
  return { userId: parts[0], planId: parts[1] };
}

/**
 * Re-query Monnify transaction status server-side.
 * Throws if the transaction is not PAID.
 */
async function _verifyMonnifyTransaction(transactionReference) {
  const MONNIFY_API_KEY = process.env.MONNIFY_API_KEY ?? '';
  const MONNIFY_SECRET  = process.env.MONNIFY_SECRET_KEY ?? '';
  const MONNIFY_BASE    = process.env.MONNIFY_BASE_URL ?? 'https://sandbox.monnify.com';

  if (!MONNIFY_API_KEY || !MONNIFY_SECRET) {
    console.warn('[monnify] Skipping re-query — credentials not configured');
    return;
  }

  const credentials = Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET}`).toString('base64');

  // 1. Get auth token
  const authRes = await fetch(`${MONNIFY_BASE}/api/v1/auth/login`, {
    method:  'POST',
    headers: { Authorization: `Basic ${credentials}` },
  });
  const authData = await authRes.json();
  const token    = authData?.responseBody?.accessToken;
  if (!token) throw new Error('Monnify re-query auth failed');

  // 2. Fetch transaction
  const txRes = await fetch(
    `${MONNIFY_BASE}/api/v2/transactions/${encodeURIComponent(transactionReference)}`,
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

  const res = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );
  const body = await res.json();

  if (!body?.status || body?.data?.status !== 'success') {
    throw new Error(`Paystack transaction not successful (status: ${body?.data?.status ?? 'unknown'})`);
  }
}

export default router;
