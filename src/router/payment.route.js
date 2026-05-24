import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/authFirebase.js';
import {
  getMembershipPlans,
  getUserMembership,
} from '../controller/membership.controller.js';
import { supabase } from '../config/supabase.js';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';
import {
  createSecurePaymentSession,
  getPaymentIntentStatus,
  processProviderWebhook,
  refreshAndFulfillPaymentIntent,
} from '../services/securePayments.service.js';
import { verifyWebhookSignature } from '../services/paymentGateway.service.js';
import {
  countryFromRequest,
  isAfricanCountry,
  paymentProviderLabel,
  resolvePaymentProvider,
} from '../services/paymentRegion.service.js';
import { logPaymentEvent } from '../services/paymentLogger.service.js';
import {
  emitFinancePayoutEvent,
  writeFinancePayoutLog,
} from '../services/financePayoutEvents.service.js';
import {
  markPayoutCompleted,
  markPayoutFailed,
} from '../services/payoutWorkflow.service.js';
import { handleFlutterwaveTransferWebhook } from '../services/flutterwaveTransfer.service.js';

const router = express.Router();

function readLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: readLimit('PAYMENT_CHECKOUT_MAX_PER_MIN', 12),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('payments:checkout'),
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: readLimit('PAYMENT_WEBHOOK_MAX_PER_MIN', 240),
  standardHeaders: false,
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('payments:webhook'),
});

router.get('/plans', async (_req, res) => {
  try {
    const plans = await getMembershipPlans();
    return res.json({ ok: true, data: plans });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/membership', requireAuth, async (req, res) => {
  try {
    const membership = await getUserMembership(req.uid);
    return res.json({ ok: true, data: membership });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/region', (req, res) => {
  const ipCountry = countryFromRequest(req);
  const countryCode = String(req.query.countryCode || '').trim().toUpperCase() || ipCountry || 'US';
  const billingCountry = String(req.query.billingCountry || '').trim().toUpperCase() || null;
  const provider = resolvePaymentProvider({ countryCode, billingCountry, ipCountry });
  return res.json({
    ok: true,
    countryCode,
    billingCountry,
    ipCountry,
    isAfrica: isAfricanCountry(billingCountry || countryCode || ipCountry),
    provider,
    providerLabel: paymentProviderLabel(provider),
  });
});

router.post('/checkout', requireAuth, checkoutLimiter, async (req, res) => {
  try {
    const {
      planId,
      countryCode = 'US',
      billingCountry = null,
      customerEmail = '',
      customerName = 'Member',
      customerPhone = '',
    } = req.body || {};

    if (!planId) return res.status(400).json({ ok: false, error: 'planId is required' });

    const paymentResp = await createSecurePaymentSession({
      userId: req.uid,
      productType: 'membership',
      productId: planId,
      countryCode,
      billingCountry,
      customerEmail,
      customerName,
      customerPhone,
      req,
    });

    return res.json({
      ok: true,
      provider: paymentResp.provider,
      providerLabel: paymentProviderLabel(paymentResp.provider),
      checkoutUrl: paymentResp.checkoutUrl,
      reference: paymentResp.reference,
      orderId: paymentResp.orderId,
      orderKey: paymentResp.orderKey,
      countryCode: paymentResp.countryCode,
      currency: paymentResp.currency,
      amount: paymentResp.amount,
      flutterwave: paymentResp.flutterwave,
    });
  } catch (err) {
    console.error('[payment] checkout error:', err.message);
    const status = /unreachable|timed out/i.test(err.message) ? 503 : 500;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

router.get('/verify/:reference', requireAuth, async (req, res) => {
  const reference = String(req.params.reference || '').trim();
  if (!reference) return res.status(400).json({ ok: false, error: 'reference is required' });
  try {
    const orderKey = String(req.query.orderKey || req.query.tx_ref || '').trim() || null;
    const status = await getPaymentIntentStatus({ reference, orderKey, userId: req.uid });
    if (!status) {
      return res.status(404).json({ ok: false, verified: false, error: 'Payment session not found.' });
    }

    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
    if (refresh && status.status !== 'fulfilled') {
      const refreshed = await refreshAndFulfillPaymentIntent({
        reference,
        orderKey,
        userId: req.uid,
      });
      if (refreshed) {
        return res.json({
          ok: true,
          verified: refreshed.verified,
          payment: refreshed.payment,
          providerStatus: refreshed.providerStatus,
          fulfillment: {
            fulfilled: refreshed.fulfilled,
            duplicate: refreshed.duplicate,
            suspicious: refreshed.suspicious,
            error: refreshed.error,
          },
        });
      }
    }

    return res.json({
      ok: true,
      verified: status.status === 'fulfilled',
      payment: status,
      providerStatus: null,
    });
  } catch (err) {
    console.error('[payment] verify failed:', err.message);
    return res.status(400).json({ ok: false, verified: false, error: err.message });
  }
});

router.post('/webhooks/paystack', webhookLimiter, async (req, res) => {
  let signature;
  try {
    signature = verifyWebhookSignature('paystack', req);
  } catch (error) {
    console.error('[paystack-webhook] signature verification unavailable:', error.message);
    return res.status(503).json({ error: 'Webhook verification is not configured.' });
  }
  if (!signature.valid) return res.status(401).json({ error: 'Invalid signature' });

  const { event, data } = req.body ?? {};

  if (event === 'charge.success' && data?.status === 'success') {
    const result = await safeProcessWebhook('paystack', req);
    return res.status(result.status || 200).json({ received: true, ...result });
  }

  if (event === 'transfer.success' || event === 'transfer.failed' || event === 'transfer.reversed') {
    try {
      await handlePaystackTransferWebhook(event === 'transfer.reversed' ? 'transfer.failed' : event, data, req.app?.get('io'));
    } catch (err) {
      console.error('[paystack-webhook] transfer payout update failed:', err.message);
    }
  }

  return res.status(200).json({ received: true });
});

router.post('/webhooks/stripe', webhookLimiter, async (req, res) => {
  const result = await safeProcessWebhook('stripe', req);
  return res.status(result.status || 200).json({ received: true, ...result });
});

router.post('/webhooks/flutterwave', webhookLimiter, async (req, res) => {
  const event = String(req.body?.event || req.body?.['event.type'] || '').toLowerCase();
  const data = req.body?.data || req.body || {};
  const looksLikeTransfer = event.startsWith('transfer.')
    || data.transfer_code
    || data.account_number
    || data.bank_code
    || String(data.reference || '').startsWith('XFLW-PAYOUT-');

  if (looksLikeTransfer) {
    const signature = verifyWebhookSignature('flutterwave', req);
    if (signature.skipped) return res.status(503).json({ error: 'Webhook verification is not configured.' });
    if (!signature.valid) return res.status(401).json({ error: 'Invalid signature' });
    const result = await handleFlutterwaveTransferWebhook(data, { io: req.app?.get('io') });
    return res.status(200).json({ received: true, transfer: true, ...result });
  }

  const result = await safeProcessWebhook('flutterwave', req);
  return res.status(result.status || 200).json({ received: true, ...result });
});

async function safeProcessWebhook(provider, req) {
  try {
    logPaymentEvent('info', 'webhook.received', { provider });
    return await processProviderWebhook(provider, req);
  } catch (error) {
    logPaymentEvent('error', 'webhook.processing_failed', { provider, error: error.message });
    return { accepted: false, status: 500, error: 'Webhook processing failed.' };
  }
}

async function handlePaystackTransferWebhook(event, data, io) {
  if (!supabase || !data) return;

  const reference = data.reference || null;
  const transferCode = data.transfer_code || null;
  if (!reference && !transferCode) return;

  let query = supabase.from('creator_payout_requests').select('*').limit(1);
  if (reference) query = query.eq('paystack_transaction_reference', reference);
  else query = query.eq('paystack_transfer_code', transferCode);

  const { data: rows, error: lookupError } = await query;
  if (lookupError) {
    console.warn('[paystack-webhook] payout lookup failed:', lookupError.message || lookupError);
    return;
  }
  const payout = rows?.[0];
  if (!payout) return;

  const isSuccess = event === 'transfer.success';
  let nextPayout;
  try {
    nextPayout = isSuccess
      ? await markPayoutCompleted({
          id: payout.id,
          admin: { id: 'paystack-webhook', name: 'Paystack Webhook' },
          transactionReference: reference,
          provider: 'paystack',
          notes: 'Paystack transfer.success webhook',
          io,
        })
      : await markPayoutFailed({
          id: payout.id,
          admin: { id: 'paystack-webhook', name: 'Paystack Webhook' },
          reason: data.reason || data.status || 'Paystack transfer failed',
          io,
        });

    await supabase
      .from('creator_payout_requests')
      .update({
        payment_provider: 'paystack',
        paystack_transfer_code: transferCode || payout.paystack_transfer_code,
        paystack_transaction_reference: reference || payout.paystack_transaction_reference,
        payment_metadata: {
          ...(nextPayout.payment_metadata || {}),
          paystackWebhookStatus: data.status || null,
        },
      })
      .eq('id', payout.id)
      .select()
      .maybeSingle();
  } catch (error) {
    console.warn('[paystack-webhook] payout transition failed:', error.message || error);
    return;
  }

  await writeFinancePayoutLog(nextPayout, nextPayout.status || (isSuccess ? 'paid' : 'failed'), {
    provider: 'paystack',
    transactionReference: reference,
    paymentDate: isSuccess ? new Date().toISOString() : null,
    errorMessage: isSuccess ? null : (data.reason || data.status || 'Paystack transfer failed'),
    metadata: { source: 'paystack_webhook', transferCode },
  });
  emitFinancePayoutEvent(io, 'finance:payout-updated', nextPayout, { status: nextPayout.status || (isSuccess ? 'paid' : 'failed') });
}

export default router;
