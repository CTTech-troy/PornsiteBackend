import { supabase } from '../config/supabase.js';
import { getRawRequestBody } from '../middleware/qstashSignature.js';
import { getCoinAnalytics } from '../services/coinWallet.service.js';
import {
  createRenewalReminderEvents,
  expireDueMemberships,
  getMembershipAnalytics,
} from '../services/membershipLifecycle.service.js';
import {
  runFailedPaymentRetry,
  runFraudAnalysis,
  runPaymentIntentExpiration,
  runPaymentReconciliation,
  runWalletVerification,
} from '../services/paymentWorkflow.service.js';

function readWorkflowPayload(req) {
  const rawBody = getRawRequestBody(req);
  if (!rawBody) return {};

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    console.warn('[monetization-workflow] ignored invalid JSON payload:', error.message);
    return {};
  }
}

export async function expireMembershipsWorkflow(req, res) {
  try {
    const payload = readWorkflowPayload(req);
    const result = await expireDueMemberships({ limit: Number(payload.limit) || 500 });
    return res.json({ success: true, workflow: 'membership_expiration', ...result });
  } catch (error) {
    console.error('[monetization-workflow] expiration failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function renewalRemindersWorkflow(req, res) {
  try {
    const payload = readWorkflowPayload(req);
    const days = Array.isArray(payload.days) ? payload.days.map(Number).filter(Boolean) : [7, 3, 1];
    const result = await createRenewalReminderEvents({ days, limit: Number(payload.limit) || 500 });
    return res.json({ success: true, workflow: 'renewal_reminders', ...result });
  } catch (error) {
    console.error('[monetization-workflow] reminders failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function recurringBillingWorkflow(_req, res) {
  // Lifecycle-ready recurring billing records renewal_due work without charging
  // saved payment methods. Provider mandate/authorization support can attach here.
  return res.json({
    success: true,
    workflow: 'recurring_billing',
    mode: 'lifecycle_ready',
    message: 'Automatic provider charges are not enabled for this deployment.',
  });
}

export async function failedPaymentRetryWorkflow(req, res) {
  try {
    const payload = readWorkflowPayload(req);
    const result = await runFailedPaymentRetry({
      limit: Number(payload.limit) || 50,
      olderThanMinutes: Number(payload.olderThanMinutes) || 15,
    });
    return res.json({ success: true, workflow: 'failed_payment_retry', ...result });
  } catch (error) {
    console.error('[monetization-workflow] failed payment retry failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function expirePaymentIntentsWorkflow(req, res) {
  try {
    const payload = readWorkflowPayload(req);
    const result = await runPaymentIntentExpiration({ limit: Number(payload.limit) || 500 });
    return res.json({ success: true, workflow: 'payment_intent_expiration', ...result });
  } catch (error) {
    console.error('[monetization-workflow] payment intent expiration failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function paymentReconciliationWorkflow(req, res) {
  try {
    const payload = readWorkflowPayload(req);
    const result = await runPaymentReconciliation({ hours: Number(payload.hours) || 24 });
    return res.json({ success: true, workflow: 'payment_reconciliation', ...result });
  } catch (error) {
    console.error('[monetization-workflow] payment reconciliation failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function fraudAnalysisWorkflow(req, res) {
  try {
    const payload = readWorkflowPayload(req);
    const result = await runFraudAnalysis({ limit: Number(payload.limit) || 100 });
    return res.json({ success: true, workflow: 'payment_fraud_analysis', ...result });
  } catch (error) {
    console.error('[monetization-workflow] fraud analysis failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function walletVerificationWorkflow(_req, res) {
  try {
    const result = await runWalletVerification();
    return res.json({ success: true, workflow: 'wallet_verification', ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function analyticsWorkflow(_req, res) {
  try {
    const [coinAnalytics, membershipAnalytics] = await Promise.all([
      getCoinAnalytics(),
      getMembershipAnalytics(),
    ]);

    if (supabase) {
      await supabase.from('coin_analytics_daily').upsert({
        period_date: new Date().toISOString().slice(0, 10),
        coins_sold: coinAnalytics.totalCoinsSold || 0,
        coins_spent: coinAnalytics.totalCoinsSpent || 0,
        coins_transferred: 0,
        revenue_usd: membershipAnalytics.revenueUsd || 0,
        transactions: coinAnalytics.transactionCount || 0,
        metadata: { coinAnalytics, membershipAnalytics },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'period_date' }).catch(() => {});
    }

    return res.json({
      success: true,
      workflow: 'monetization_analytics',
      coinAnalytics,
      membershipAnalytics,
    });
  } catch (error) {
    console.error('[monetization-workflow] analytics failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function monetizationWorkflowFailure(req, res) {
  console.warn('[monetization-workflow] failure callback', {
    messageId: req.get('Upstash-Message-Id') || null,
    body: readWorkflowPayload(req),
  });
  return res.json({ success: true, received: true });
}
