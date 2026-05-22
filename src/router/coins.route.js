import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/authFirebase.js';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';
import {
  buyCoinPackage,
  getMyCoinTransactions,
  getMyCoinWallet,
  getPublicCoinPackages,
  getPublicGiftCatalog,
  giftCreator,
  spendMyCoins,
  transferMyCoins,
} from '../controller/coins.controller.js';

const router = Router();
const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.PAYMENT_CHECKOUT_MAX_PER_MIN || 12),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('coins:purchase'),
});

const walletActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.COIN_WALLET_MAX_PER_MIN || 30),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('coins:wallet'),
});

router.get('/packages', getPublicCoinPackages);
router.get('/gifts', getPublicGiftCatalog);
router.get('/wallet', requireAuth, getMyCoinWallet);
router.get('/transactions', requireAuth, getMyCoinTransactions);
router.post('/purchase', requireAuth, purchaseLimiter, buyCoinPackage);
router.post('/spend', requireAuth, walletActionLimiter, spendMyCoins);
router.post('/transfer', requireAuth, walletActionLimiter, transferMyCoins);
router.post('/gift', requireAuth, walletActionLimiter, giftCreator);

export default router;
