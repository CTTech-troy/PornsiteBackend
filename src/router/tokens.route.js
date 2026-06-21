/**
 * tokens.route.js  —  mounted at /api/tokens
 *
 * GET  /api/tokens/balance          — current user's token balance (auth required)
 * GET  /api/tokens/packages         — list of buyable token packages (public)
 * POST /api/tokens/send-gift        — atomic deduct + gift record + socket emit (auth required)
 * POST /api/tokens/purchase         — create payment checkout for a token package (auth required)
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/authFirebase.js';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';
import {
  createTokenCheckout,
  getTokenBalance,
  getTokenPackages,
  sendGift,
} from '../controller/tokens.controller.js';

const router = express.Router();
const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.PAYMENT_CHECKOUT_MAX_PER_MIN || 12),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('tokens:purchase'),
});

const walletActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.COIN_WALLET_MAX_PER_MIN || 30),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('tokens:wallet'),
});

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
router.get('/packages', async (_req, res) => {
  try {
    const packages = await getTokenPackages();
    return res.json({ ok: true, data: packages });
  } catch (err) {
    console.error('[tokens] packages error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load coin packages.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tokens/send-gift
// Body: { creatorId, streamId, gift: { id, name, emoji, price }, senderName? }
// ---------------------------------------------------------------------------
router.post('/send-gift', requireAuth, walletActionLimiter, async (req, res) => {
  const { creatorId, streamId, giftId, gift, senderName } = req.body ?? {};
  const resolvedGiftId = giftId || gift?.id;

  if (!creatorId || !streamId || !resolvedGiftId) {
    return res.status(400).json({ ok: false, error: 'creatorId, streamId, and giftId are required' });
  }

  try {
    const result = await sendGift({
      userId: req.uid,
      senderName,
      creatorId,
      streamId,
      giftId: resolvedGiftId,
      gift,
    });

    emitGiftRealtime(req, {
      streamId,
      senderId: req.uid,
      senderName,
      result,
    });

    return res.json({
      ok: true,
      newBalance: result.newBalance,
      giftId: result.giftId,
      liveGiftId: result.liveGiftId,
      totalGiftsAmount: result.totalGiftsAmount,
      creatorAmount: result.creatorAmount,
      platformAmount: result.platformAmount,
      gift: result.gift,
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_TOKENS') {
      return res.status(402).json({ ok: false, error: err.message, code: 'INSUFFICIENT_TOKENS' });
    }
    if (err.code === 'GIFT_NOT_FOUND') {
      return res.status(400).json({ ok: false, error: err.message, code: err.code });
    }
    if (err.code === 'GIFT_SYSTEM_UNAVAILABLE') {
      return res.status(503).json({ ok: false, error: err.message, code: err.code });
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
router.post('/purchase', requireAuth, purchaseLimiter, async (req, res) => {
  const {
    packageId,
    countryCode   = 'US',
    billingCountry = null,
    customerEmail = '',
    customerName  = 'Member',
    customerPhone = '',
  } = req.body ?? {};

  try {
    const paymentResp = await createTokenCheckout({
      userId: req.uid,
      packageId,
      countryCode,
      billingCountry,
      customerEmail,
      customerName,
      customerPhone,
      req,
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

function emitGiftRealtime(req, { streamId, senderId, senderName, result }) {
  const io = req.app?.get?.('io');
  if (!io || !streamId || !result?.gift) return;
  const gift = result.gift;
  const payload = {
    id: result.liveGiftId || result.giftId || `${Date.now()}`,
    liveId: result.liveGiftId ? streamId : undefined,
    roomId: result.liveGiftId ? undefined : streamId,
    senderId,
    senderName: senderName || 'Viewer',
    giftId: gift.id,
    giftType: gift.id,
    giftName: gift.name,
    name: gift.name,
    emoji: gift.emoji,
    imageUrl: gift.imageUrl,
    animationType: gift.animationType,
    category: gift.category,
    rarity: gift.rarity,
    amount: Number(gift.coinCost || gift.price || 0),
    totalGiftsAmount: result.totalGiftsAmount,
    createdAt: new Date().toISOString(),
  };
  if (result.liveGiftId) io.to(streamId).emit('new-gift', payload);
  else io.to(streamId).emit('chat:gift', payload);
}
