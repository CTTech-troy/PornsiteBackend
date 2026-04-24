/**
 * tokens.route.js  —  mounted at /api/tokens
 *
 * GET  /api/tokens/balance          — current user's token balance (auth required)
 * GET  /api/tokens/packages         — list of buyable token packages (public)
 * POST /api/tokens/send-gift        — atomic deduct + gift record + socket emit (auth required)
 * POST /api/tokens/purchase         — create payment checkout for a token package (auth required)
 */

import express from 'express';
import { requireAuth } from '../middleware/authFirebase.js';
import {
  getTokenBalance,
  sendGift,
  TOKEN_PACKAGES,
} from '../controller/tokens.controller.js';
import { createCheckout } from '../services/paymentServiceClient.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/tokens/balance
// ---------------------------------------------------------------------------
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const balance = await getTokenBalance(req.uid);
    return res.json({ ok: true, balance });
  } catch (err) {
    console.error('[tokens] getTokenBalance error:', err.message);
    // Return 0 rather than 500 so the UI stays functional before migration runs
    return res.json({ ok: true, balance: 0 });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tokens/packages
// ---------------------------------------------------------------------------
router.get('/packages', (_req, res) => {
  return res.json({ ok: true, data: TOKEN_PACKAGES });
});

// ---------------------------------------------------------------------------
// POST /api/tokens/send-gift
// Body: { creatorId, streamId, gift: { id, name, emoji, price }, senderName? }
// ---------------------------------------------------------------------------
router.post('/send-gift', requireAuth, async (req, res) => {
  const { creatorId, streamId, gift, senderName } = req.body ?? {};

  if (!creatorId || !streamId || !gift?.id || !gift?.price) {
    return res.status(400).json({ ok: false, error: 'creatorId, streamId, and gift (id, price) are required' });
  }

  try {
    const result = await sendGift({
      userId:    req.uid,
      senderName,
      creatorId,
      streamId,
      gift,
    });

    return res.json({ ok: true, newBalance: result.newBalance, giftId: result.giftId });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_TOKENS') {
      return res.status(402).json({ ok: false, error: err.message, code: 'INSUFFICIENT_TOKENS' });
    }
    console.error('[tokens] send-gift error:', err.message);
    return res.status(500).json({ ok: false, error: 'Gift failed. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tokens/purchase
// Body: { packageId, countryCode, customerEmail?, customerName? }
// Creates a checkout session via the C# payment service.
// The webhook handler (payment.route.js) recognises planId = tokens_* and
// calls addTokens() instead of activatePlan().
// ---------------------------------------------------------------------------
router.post('/purchase', requireAuth, async (req, res) => {
  const {
    packageId,
    countryCode   = 'US',
    customerEmail = '',
    customerName  = 'Member',
  } = req.body ?? {};

  const pkg = TOKEN_PACKAGES.find(p => p.id === packageId);
  if (!pkg) {
    return res.status(400).json({ ok: false, error: `Unknown package: ${packageId}` });
  }

  try {
    const isNigeria = countryCode.trim().toUpperCase() === 'NG';
    const amount    = isNigeria ? pkg.priceNgn : pkg.priceUsd;
    const currency  = isNigeria ? 'NGN' : 'USD';
    const orderId   = `${req.uid}_${pkg.id}_${Date.now()}`;

    const paymentResp = await createCheckout({
      orderId,
      userId:      req.uid,
      planId:      pkg.id,
      countryCode: countryCode.trim().toUpperCase(),
      currency,
      amount,
      productName: `${pkg.tokens} Tokens`,
      customerEmail,
      customerName,
    });

    return res.json({
      ok:          true,
      provider:    paymentResp.provider,
      checkoutUrl: paymentResp.checkoutUrl,
      reference:   paymentResp.reference,
    });
  } catch (err) {
    const status = /unreachable|timed out/i.test(err.message) ? 503 : 500;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

export default router;
