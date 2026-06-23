import { supabase } from '../config/supabase.js';
import {
  emitPayoutRealtime,
  markPayoutCompleted,
  markPayoutFailed,
} from './payoutWorkflow.service.js';
import {
  writeFinanceActivityEvent,
  writeFinancePayoutLog,
} from './financePayoutEvents.service.js';
import { assertFlutterwaveLiveSecretForProduction } from '../utils/flutterwaveKeys.js';

const FLUTTERWAVE_BASE_URL = 'https://api.flutterwave.com/v3';

function flutterwaveHeaders() {
  const key = process.env.FLUTTERWAVE_SECRET_KEY || '';
  if (!key) {
    const err = new Error('Flutterwave secret key is not configured.');
    err.code = 'FLUTTERWAVE_NOT_CONFIGURED';
    throw err;
  }
  assertFlutterwaveLiveSecretForProduction(key);
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function flutterwaveFetch(path, options = {}) {
  const response = await fetch(`${FLUTTERWAVE_BASE_URL}${path}`, {
    ...options,
    headers: { ...flutterwaveHeaders(), ...options.headers },
    signal: AbortSignal.timeout(Number(process.env.FLUTTERWAVE_TIMEOUT_MS || 15000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || String(payload.status || '').toLowerCase() !== 'success') {
    const err = new Error(payload.message || `Flutterwave request failed with HTTP ${response.status}`);
    err.code = 'FLUTTERWAVE_REQUEST_FAILED';
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function normalizeTransferStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['successful', 'success', 'completed'].includes(value)) return 'completed';
  if (['failed', 'cancelled', 'canceled', 'reversed'].includes(value)) return 'failed';
  if (['pending', 'processing', 'new'].includes(value)) return 'processing';
  return value || 'processing';
}

export async function listFlutterwaveBanks(country = 'NG') {
  const payload = await flutterwaveFetch(`/banks/${encodeURIComponent(country || 'NG')}`);
  return (payload.data || []).map((bank) => ({
    name: bank.name,
    code: bank.code,
    country: bank.country || country || 'NG',
  }));
}

export async function resolveFlutterwaveBankAccount({ accountNumber, bankCode }) {
  if (!accountNumber || !bankCode) {
    const err = new Error('Account number and bank code are required.');
    err.code = 'INVALID_BANK_ACCOUNT';
    throw err;
  }
  const payload = await flutterwaveFetch('/accounts/resolve', {
    method: 'POST',
    body: JSON.stringify({
      account_number: accountNumber,
      account_bank: bankCode,
    }),
  });
  return {
    accountName: payload.data?.account_name || payload.data?.accountName || '',
    accountNumber: payload.data?.account_number || accountNumber,
    bankCode,
    raw: payload,
  };
}

export async function createFlutterwaveTransfer({
  amountNgn,
  accountNumber,
  bankCode,
  reference,
  narration,
  beneficiaryName = '',
}) {
  const amount = Number(amountNgn);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('A valid NGN payout amount is required.');
    err.code = 'INVALID_TRANSFER_AMOUNT';
    throw err;
  }
  if (!accountNumber || !bankCode) {
    const err = new Error('Creator bank code and account number are required for Flutterwave transfer.');
    err.code = 'INVALID_TRANSFER_RECIPIENT';
    throw err;
  }

  const payload = await flutterwaveFetch('/transfers', {
    method: 'POST',
    body: JSON.stringify({
      account_bank: bankCode,
      account_number: accountNumber,
      amount: Math.round(amount * 100) / 100,
      narration: narration || 'Creator payout',
      currency: 'NGN',
      reference,
      debit_currency: 'NGN',
      beneficiary_name: beneficiaryName || undefined,
    }),
  });

  const data = payload.data || {};
  return {
    id: data.id ? String(data.id) : null,
    reference: data.reference || reference,
    status: normalizeTransferStatus(data.status),
    raw: payload,
  };
}

export async function verifyFlutterwaveTransfer(transferId) {
  if (!transferId) throw new Error('Flutterwave transfer id is required.');
  const payload = await flutterwaveFetch(`/transfers/${encodeURIComponent(transferId)}`);
  const data = payload.data || {};
  return {
    id: data.id ? String(data.id) : String(transferId),
    reference: data.reference || data.complete_message || null,
    status: normalizeTransferStatus(data.status),
    raw: payload,
  };
}

export async function processCreatorFlutterwavePayoutTransfer(payout) {
  const amountNgn = Number(payout.amount_ngn || 0);
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    throw new Error('Payout must have an NGN amount before Flutterwave transfer.');
  }

  const transfer = await createFlutterwaveTransfer({
    amountNgn,
    accountNumber: payout.account_number,
    bankCode: payout.bank_code,
    beneficiaryName: payout.account_name || payout.creator_name,
    reference: payout.flutterwave_reference || payout.reference,
    narration: `XStreamVideos creator payout ${payout.reference_id || payout.id}`,
  });

  return transfer;
}

async function findPayoutForFlutterwaveTransfer({ transferId, reference }) {
  if (!supabase) return null;

  const filters = [];
  if (transferId) filters.push(['flutterwave_transfer_id', transferId]);
  if (reference) {
    filters.push(['flutterwave_transaction_reference', reference]);
    filters.push(['transaction_reference', reference]);
  }

  for (const [column, value] of filters) {
    const { data, error } = await supabase
      .from('creator_payout_requests')
      .select('*')
      .eq(column, value)
      .limit(1);
    if (!error && data?.[0]) return data[0];
  }

  return null;
}

export async function handleFlutterwaveTransferWebhook(data = {}, { io = null, admin = null } = {}) {
  const transferId = data.id ? String(data.id) : null;
  const reference = data.reference || data.tx_ref || data.transfer_reference || null;
  const status = normalizeTransferStatus(data.status);
  const payout = await findPayoutForFlutterwaveTransfer({ transferId, reference });
  if (!payout) return { matched: false, status, reference, transferId };

  const metadata = {
    flutterwaveStatus: data.status || status,
    flutterwaveTransferId: transferId,
    flutterwaveReference: reference,
    webhook: data,
  };

  if (status === 'completed' && !['completed', 'paid'].includes(payout.status)) {
    const completed = await markPayoutCompleted({
      id: payout.id,
      admin,
      transactionReference: reference || payout.transaction_reference,
      provider: 'flutterwave',
      notes: 'Flutterwave transfer webhook confirmed payment.',
      io,
    });
    await supabase
      .from('creator_payout_requests')
      .update({
        flutterwave_status: data.status || status,
        payment_metadata: { ...(payout.payment_metadata || {}), ...metadata },
      })
      .eq('id', payout.id)
      .then(() => null, () => null);
    return { matched: true, payout: completed, status };
  }

  if (status === 'failed' && !['completed', 'paid', 'failed', 'rejected'].includes(payout.status)) {
    const failed = await markPayoutFailed({
      id: payout.id,
      admin,
      reason: data.complete_message || data.message || 'Flutterwave transfer failed.',
      io,
    });
    return { matched: true, payout: failed, status };
  }

  if (supabase) {
    const { data: updated } = await supabase
      .from('creator_payout_requests')
      .update({
        flutterwave_status: data.status || status,
        payment_metadata: { ...(payout.payment_metadata || {}), ...metadata },
        updated_at: new Date().toISOString(),
      })
      .eq('id', payout.id)
      .select()
      .maybeSingle();
    if (updated) {
      emitPayoutRealtime(io, 'finance:payout-updated', updated, { status: updated.status });
    }
  }

  await writeFinancePayoutLog(payout, payout.status, {
    provider: 'flutterwave',
    transactionReference: reference,
    metadata,
  });
  await writeFinanceActivityEvent({
    eventType: status === 'failed' ? 'payout_failed' : 'payout_updated',
    creatorId: payout.creator_id,
    amountUsd: payout.amount_usd,
    provider: 'flutterwave',
    reference,
    status,
    metadata,
  }, { io });

  return { matched: true, payout, status };
}
