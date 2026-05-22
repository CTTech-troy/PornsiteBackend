import { supabase, isConfigured } from '../config/supabase.js';
import { verifyProviderTransaction } from './paymentGateway.service.js';
import {
  expireStalePaymentIntents,
  getFraudAlerts,
  getPaymentReconciliationReport,
  getPaymentMonitoring,
} from './securePayments.service.js';
import { getCoinAnalytics } from './coinWallet.service.js';

function isMissingDbFeature(error) {
  const message = String(error?.message || '');
  return (
    error?.code === '42883' ||
    error?.code === '42P01' ||
    error?.code === 'PGRST200' ||
    /does not exist|schema cache/i.test(message)
  );
}

export async function runPaymentReconciliation({ hours = 24 } = {}) {
  const report = await getPaymentReconciliationReport({ hours });
  const monitoring = await getPaymentMonitoring({ page: 1, limit: 20 });
  return {
    report,
    monitoringStats: monitoring?.stats || {},
    needsReview: (report.orphanFulfillments?.length || 0) > 0 || (report.openFraudAlerts || 0) > 0,
  };
}

export async function runFailedPaymentRetry({ limit = 50, olderThanMinutes = 15 } = {}) {
  if (!isConfigured() || !supabase) {
    return { checked: 0, updated: 0, message: 'Supabase not configured' };
  }

  const cutoff = new Date(Date.now() - Math.max(5, Number(olderThanMinutes) || 15) * 60_000).toISOString();
  const { data, error } = await supabase
    .from('payment_intents')
    .select('id,intent_key,provider,provider_reference,status,created_at')
    .in('status', ['checkout_created', 'processing'])
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)));

  if (error) {
    if (isMissingDbFeature(error)) return { checked: 0, updated: 0, skipped: true };
    throw error;
  }

  const results = [];
  for (const intent of data || []) {
    if (!intent.provider || !intent.provider_reference) {
      results.push({ intentId: intent.id, action: 'skipped_missing_provider' });
      continue;
    }
    try {
      const verified = await verifyProviderTransaction(intent.provider, {
        reference: intent.provider_reference,
        orderKey: intent.intent_key,
      });
      const nextStatus = verified.successful ? 'processing' : 'failed';
      await supabase
        .from('payment_intents')
        .update({ status: nextStatus, updated_at: new Date().toISOString() })
        .eq('id', intent.id);
      results.push({
        intentId: intent.id,
        action: 'provider_polled',
        providerStatus: verified.status,
        note: 'Fulfillment remains webhook-only; no balance credited from retry job',
      });
    } catch (pollError) {
      results.push({ intentId: intent.id, action: 'poll_failed', error: pollError.message });
    }
  }

  return { checked: data?.length || 0, updated: results.length, results };
}

export async function runFraudAnalysis({ limit = 100 } = {}) {
  const [alerts, suspicious] = await Promise.all([
    getFraudAlerts({ page: 1, limit: 50, status: 'open' }),
    getPaymentMonitoring({ page: 1, limit: Math.min(100, Number(limit) || 100), statusFilter: 'suspicious' }),
  ]);

  return {
    openAlerts: alerts.total,
    alerts: alerts.alerts,
    suspiciousPayments: suspicious?.payments || [],
    suspiciousCount: suspicious?.total || 0,
  };
}

export async function runWalletVerification() {
  const analytics = await getCoinAnalytics();
  if (!isConfigured() || !supabase) {
    return { analytics, mismatches: [], message: 'Supabase not configured' };
  }

  const { data: wallets, error } = await supabase
    .from('coin_wallets')
    .select('user_id,balance')
    .order('updated_at', { ascending: false })
    .limit(100);

  if (error) {
    if (isMissingDbFeature(error)) return { analytics, mismatches: [], skipped: true };
    throw error;
  }

  const mismatches = [];
  for (const wallet of wallets || []) {
    const { data: txs, error: txErr } = await supabase
      .from('coin_wallet_transactions')
      .select('amount,type')
      .eq('user_id', wallet.user_id)
      .limit(500);
    if (txErr) continue;

    let computed = 0;
    for (const tx of txs || []) {
      const amt = Number(tx.amount || 0);
      if (['purchase', 'bonus', 'receive', 'transfer_in', 'adjustment'].includes(tx.type)) computed += amt;
      else computed -= amt;
    }
    if (Math.abs(computed - Number(wallet.balance || 0)) > 0.01) {
      mismatches.push({ userId: wallet.user_id, walletBalance: wallet.balance, computed });
    }
  }

  return { analytics, mismatches, sampledWallets: wallets?.length || 0 };
}

export async function runPaymentIntentExpiration({ limit = 500 } = {}) {
  return expireStalePaymentIntents({ limit });
}
