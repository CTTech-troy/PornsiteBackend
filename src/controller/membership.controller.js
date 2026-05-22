import {
  activateMembershipFromPayment,
  getMembershipPlans as getMembershipPlansFromService,
  getUserMembership as getUserMembershipFromService,
  isPaymentAlreadyProcessed as isPaymentAlreadyProcessedByService,
} from '../services/membershipLifecycle.service.js';
import { spendCoins as spendWalletCoins } from '../services/coinWallet.service.js';

export async function getMembershipPlans() {
  return getMembershipPlansFromService();
}

export async function getUserMembership(userId) {
  return getUserMembershipFromService(userId);
}

export async function isPaymentAlreadyProcessed(reference) {
  return isPaymentAlreadyProcessedByService(reference);
}

export async function activatePlan(userId, planId, payment = {}) {
  return activateMembershipFromPayment(userId, planId, {
    reference: payment.reference,
    provider: payment.provider,
    amountPaidUsd: payment.amountPaidUsd,
    currency: payment.currency || 'USD',
    orderKey: payment.orderKey || null,
    metadata: payment.metadata || {},
  });
}

export async function spendCoins(userId, amount) {
  const result = await spendWalletCoins({
    userId,
    amount: Number(amount),
    type: 'spend',
    sourceType: 'legacy_spend',
  });
  return { coinBalance: Number(result.balance || 0), transactionId: result.transactionId || null };
}
