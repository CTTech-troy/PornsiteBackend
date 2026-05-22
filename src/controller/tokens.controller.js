import {
  STATIC_COIN_PACKAGES,
  fulfillCoinPurchase,
  getCoinPackages,
  getCoinWallet,
  sendCreatorGift,
  spendCoins as spendWalletCoins,
} from '../services/coinWallet.service.js';
import { createSecurePaymentSession } from '../services/securePayments.service.js';

export const TOKEN_PACKAGES = STATIC_COIN_PACKAGES.map((pkg) => ({
  id: pkg.id,
  tokens: pkg.coins,
  priceUsd: pkg.priceUsd,
  priceNgn: pkg.priceNgn,
}));

export async function getTokenBalance(userId) {
  const wallet = await getCoinWallet(userId);
  return Number(wallet.balance || 0);
}

export async function getTokenPackages() {
  return getCoinPackages();
}

export async function addTokens(userId, amount, { reference, paymentAmount, currency = 'USD', packageId = null, provider = null } = {}) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Direct token crediting is disabled. Use verified payment webhooks only.');
  }
  if (!packageId) {
    throw new Error('packageId is required for token crediting');
  }
  const result = await fulfillCoinPurchase({
    userId,
    packageId,
    reference,
    provider,
    amountPaid: paymentAmount,
    currency,
    metadata: { devOnly: true },
  });
  return Number(result.balance || 0);
}

export async function spendTokens(userId, amount, metadata = {}) {
  const result = await spendWalletCoins({
    userId,
    amount: Number(amount),
    type: 'spend',
    metadata,
    sourceType: metadata.sourceType || 'token_spend',
    sourceId: metadata.sourceId || null,
  });
  return { coinBalance: Number(result.balance || 0), transactionId: result.transactionId || null };
}

export async function sendGift({ userId, senderName, creatorId, streamId, giftId, gift }) {
  return sendCreatorGift({
    userId,
    senderName,
    creatorId,
    streamId,
    giftId: giftId || gift?.id,
    gift,
  });
}

export async function createTokenCheckout(params) {
  return createSecurePaymentSession({
    userId: params.userId,
    productType: 'coins',
    productId: params.packageId,
    countryCode: params.countryCode,
    customerEmail: params.customerEmail,
    customerName: params.customerName,
    req: params.req || null,
  });
}
