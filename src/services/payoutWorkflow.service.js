import { randomUUID } from 'crypto';
import { supabase, isConfigured } from '../config/supabase.js';
import { getPayoutWorkflowUrl, qstashClient } from '../config/qstash.js';
import { markRedisError, upstashRedis } from '../config/redis.js';
import { getNgnToUsdRate } from '../utils/exchangeRate.js';
import { logAdminAction } from './adminAudit.service.js';
import {
  sendPayoutApprovedEmail,
  sendPayoutPaidEmail,
  sendPayoutRejectedEmail,
  sendPayoutRequestedEmail,
} from './emailService.js';
import { createPayoutReceipt, getReceiptForPayout } from './receiptService.js';
import { sendPayoutReceiptEmail, receiptEmailSubject } from './payoutEmailService.js';
import {
  emitFinancePayoutEvent,
  writeFinancePayoutLog,
} from './financePayoutEvents.service.js';
import { getCreatorWalletBalance, invalidateRevenueCache } from './revenueCalculation.service.js';

const ACTIVE_STATUSES = ['pending', 'approved', 'processing'];
const COMMITTED_STATUSES = ['pending', 'approved', 'processing', 'paid', 'completed'];
const FINAL_STATUSES = ['paid', 'completed', 'rejected', 'failed'];
const PAYOUT_ANALYTICS_CACHE_KEY = 'finance:payouts:analytics:v1';

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function isMissingDbFeature(error) {
  const message = String(error?.message || '');
  return (
    error?.code === '42883' ||
    error?.code === '42P01' ||
    error?.code === '42703' ||
    error?.code === 'PGRST200' ||
    /schema cache|function .* does not exist|does not exist/i.test(message)
  );
}

function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.ip || req?.socket?.remoteAddress || null;
}

async function readCache(key) {
  if (!upstashRedis) return null;
  try {
    const value = await upstashRedis.get(key);
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return value;
  } catch (error) {
    markRedisError(error);
    return null;
  }
}

async function writeCache(key, value, ttlSeconds = 30) {
  if (!upstashRedis) return;
  try {
    await upstashRedis.set(key, value, { ex: ttlSeconds });
  } catch (error) {
    markRedisError(error);
  }
}

async function invalidatePayoutCache() {
  invalidateRevenueCache();
  if (!upstashRedis) return;
  try {
    await upstashRedis.del(PAYOUT_ANALYTICS_CACHE_KEY);
  } catch (error) {
    markRedisError(error);
  }
}

function publicPayout(payout) {
  if (!payout) return null;
  return {
    ...payout,
    account_number_masked: payout.account_number
      ? String(payout.account_number).slice(-4).padStart(String(payout.account_number).length, '*')
      : null,
    estimated_processing_time: 'Payment processing may take up to 24 hours',
  };
}

function payoutEmailPayload(payout) {
  return {
    to: payout.creator_email,
    name: payout.creator_name || payout.account_name || 'Creator',
    amountUsd: payout.amount_usd,
    amountNgn: payout.amount_ngn,
    bankName: payout.bank_name,
    accountNumber: payout.account_number,
    accountName: payout.account_name || payout.creator_name,
    referenceId: payout.reference_id,
  };
}

export function calculateRiskFlags({ amountUsd, available, history = [], duplicateAccountCount = 0 }) {
  const flags = [];
  const largeThreshold = Number(process.env.PAYOUT_LARGE_WITHDRAWAL_USD || 500);
  const balancePct = available > 0 ? (Number(amountUsd) / available) * 100 : 0;
  const recentRejected = history.filter((row) => ['rejected', 'failed'].includes(row.status)).length;

  if (amountUsd >= largeThreshold) flags.push('large_withdrawal');
  if (balancePct >= 90) flags.push('near_full_balance_withdrawal');
  if (duplicateAccountCount > 0) flags.push('bank_account_used_by_multiple_creators');
  if (recentRejected >= 2) flags.push('recent_failed_or_rejected_payouts');

  const score = Math.min(100, (flags.includes('large_withdrawal') ? 35 : 0)
    + (flags.includes('near_full_balance_withdrawal') ? 25 : 0)
    + (flags.includes('bank_account_used_by_multiple_creators') ? 30 : 0)
    + (flags.includes('recent_failed_or_rejected_payouts') ? 20 : 0));

  return { riskScore: score, riskFlags: flags };
}

async function insertPayoutAudit({ payout, action, actorId = null, actorType = 'system', fromStatus = null, toStatus = null, notes = '', metadata = {}, req = null }) {
  if (!supabase || !payout?.id) return null;
  const row = {
    payout_request_id: payout.id,
    actor_id: actorId,
    actor_type: actorType,
    action,
    from_status: fromStatus,
    to_status: toStatus,
    notes: notes || null,
    metadata,
    ip_address: clientIp(req),
    user_agent: req?.headers?.['user-agent'] || null,
  };
  const { data, error } = await supabase.from('payout_audit_logs').insert(row).select().maybeSingle();
  if (error && !isMissingDbFeature(error)) console.warn('[payout] audit insert failed:', error.message || error);
  return data || null;
}

async function insertPayoutTransaction({ payout, status, provider = 'manual', reference = null, proofUrl = null, errorMessage = null, actorId = null, metadata = {} }) {
  if (!supabase || !payout?.id) return null;
  const row = {
    payout_request_id: payout.id,
    creator_id: payout.creator_id,
    provider,
    provider_reference: metadata.providerReference || null,
    transaction_reference: reference || payout.transaction_reference || payout.paystack_transaction_reference || payout.reference_id || null,
    amount_usd: Number(payout.amount_usd || 0),
    amount_ngn: payout.amount_ngn == null ? null : Number(payout.amount_ngn || 0),
    status,
    attempt: Number(payout.retry_count || 0) + 1,
    proof_url: proofUrl || payout.proof_url || null,
    metadata,
    error_message: errorMessage,
    verified_at: ['paid', 'completed'].includes(status) ? new Date().toISOString() : null,
    created_by: actorId,
  };
  const { data, error } = await supabase.from('payout_transactions').insert(row).select().maybeSingle();
  if (error && !isMissingDbFeature(error)) console.warn('[payout] transaction insert failed:', error.message || error);
  return data || null;
}

export async function getCreatorPayoutBalances(creatorId) {
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');

  const wallet = await getCreatorWalletBalance(creatorId);
  const { data: payouts } = await supabase
    .from('creator_payout_requests')
    .select('amount_usd,status')
    .eq('creator_id', creatorId);
  const payoutRows = payouts || [];
  const pending = money(payoutRows.filter((row) => row.status === 'pending').reduce((sum, row) => sum + Number(row.amount_usd || 0), 0));
  const processing = money(payoutRows.filter((row) => ['approved', 'processing'].includes(row.status)).reduce((sum, row) => sum + Number(row.amount_usd || 0), 0));
  const withdrawn = money(wallet.paidOut);
  const failed = money(payoutRows.filter((row) => row.status === 'failed').reduce((sum, row) => sum + Number(row.amount_usd || 0), 0));
  const rejected = money(payoutRows.filter((row) => row.status === 'rejected').reduce((sum, row) => sum + Number(row.amount_usd || 0), 0));
  const available = wallet.available;
  const total = wallet.totalEarnings;

  let walletRes = { data: null };
  try {
    walletRes = await supabase.from('wallets').select('*').eq('owner_id', creatorId).maybeSingle();
  } catch (_) {
    /* optional */
  }

  return {
    total,
    available,
    pending,
    processing,
    withdrawn,
    failed,
    rejected,
    wallet: walletRes.data || null,
  };
}

async function enqueuePayoutWorkflow(path, body, { delaySeconds = 0, retries = 3 } = {}) {
  const url = getPayoutWorkflowUrl(path);
  if (!qstashClient || !url) {
    return { queued: false, reason: 'QStash is not configured.' };
  }

  const result = await qstashClient.publishJSON({
    url,
    body,
    delay: delaySeconds > 0 ? delaySeconds : undefined,
    retries,
    retryDelay: process.env.QSTASH_PAYOUT_RETRY_DELAY || '1000 * pow(2, retried)',
    failureCallback: getPayoutWorkflowUrl('/failure'),
    headers: {
      'Content-Type': 'application/json',
      'X-Workflow-Source': 'upstash-qstash',
    },
  });

  return { queued: true, ...result };
}

export async function enqueuePayoutNotification(type, payout, extra = {}) {
  const queued = await enqueuePayoutWorkflow('/notify', {
    type,
    payoutId: payout.id,
    creatorId: payout.creator_id,
    payload: {
      payout,
      ...extra,
    },
  }, {
    retries: readPositiveInteger('QSTASH_PAYOUT_NOTIFICATION_RETRIES', 3),
  });
  if (!queued?.queued) {
    await runPayoutNotification({
      type,
      payoutId: payout.id,
      payload: { payout, ...extra },
    });
  }
  return queued;
}

export async function runPayoutNotification({ type, payoutId, payload = {} }) {
  if (!supabase) return { success: false, reason: 'Supabase not configured.' };
  const payout = payload.payout || (await getPayoutById(payoutId));
  if (!payout) return { success: false, reason: 'Payout not found.' };

  const notificationMap = {
    submitted: {
      title: 'Withdrawal request submitted',
      message: 'Your withdrawal request was submitted and is waiting for admin review.',
    },
    approved: {
      title: 'Withdrawal approved',
      message: 'Your withdrawal was approved. Payment processing may take up to 24 hours.',
    },
    processing: {
      title: 'Payout is processing',
      message: 'Your payout is now with the finance team. Payment processing may take up to 24 hours.',
    },
    completed: {
      title: 'Payout completed',
      message: 'Your payout has been completed successfully.',
    },
    rejected: {
      title: 'Withdrawal rejected',
      message: payout.rejection_reason || 'Your withdrawal was rejected and the balance was restored.',
    },
    failed: {
      title: 'Payout failed',
      message: payout.failure_reason || 'The payout failed. Your available balance was restored.',
    },
  };

  const config = notificationMap[type] || notificationMap.processing;
  await supabase.from('creator_notifications').insert({
    user_id: payout.creator_id,
    type: `payout_${type}`,
    title: config.title,
    message: config.message,
    data: { payoutId: payout.id, referenceId: payout.reference_id, status: payout.status },
  });

  if (['submitted', 'approved', 'processing', 'completed', 'rejected', 'failed'].includes(type)) {
    const financeTitle = type === 'submitted' ? 'New withdrawal request'
      : type === 'failed' ? 'Payout processing failed'
      : `Payout ${type}`;
    await supabase.from('finance_notifications').insert({
      role: 'finance',
      type: `payout_${type}`,
      title: financeTitle,
      message: `${payout.creator_name || 'Creator'} - $${Number(payout.amount_usd || 0).toFixed(2)} - ${payout.status}`,
      data: { payoutId: payout.id, referenceId: payout.reference_id, riskFlags: payout.risk_flags || [] },
    });
  }

  const emailPayload = payoutEmailPayload(payout);
  if (payout.creator_email) {
    if (type === 'submitted') await sendPayoutRequestedEmail(emailPayload);
    else if (type === 'approved' || type === 'processing') await sendPayoutApprovedEmail(emailPayload);
    else if (type === 'completed') {
      let receipt = await getReceiptForPayout(payout.id, 'paid');
      if (!receipt?.html_body) receipt = await createPayoutReceipt(payout, 'paid');
      const htmlBody = receipt?.html_body || receipt?.htmlBody;
      if (htmlBody) {
        await sendPayoutReceiptEmail({
          to: payout.creator_email,
          subject: receiptEmailSubject('paid', receipt.receiptNumber, payout.amount_usd),
          htmlBody,
          payoutId: payout.id,
          receiptId: receipt?.id,
        });
      } else {
        await sendPayoutPaidEmail(emailPayload);
      }
    } else if (type === 'rejected') {
      let receipt = await getReceiptForPayout(payout.id, 'rejected');
      if (!receipt?.html_body) receipt = await createPayoutReceipt(payout, 'rejected');
      const htmlBody = receipt?.html_body || receipt?.htmlBody;
      if (htmlBody) {
        await sendPayoutReceiptEmail({
          to: payout.creator_email,
          subject: receiptEmailSubject('rejected', receipt.receiptNumber, payout.amount_usd),
          htmlBody,
          payoutId: payout.id,
          receiptId: receipt?.id,
        });
      } else {
        await sendPayoutRejectedEmail({ ...emailPayload, reason: config.message });
      }
    } else if (type === 'failed') {
      await sendPayoutRejectedEmail({ ...emailPayload, reason: config.message });
    }
  }

  return { success: true, type, payoutId: payout.id };
}

export async function getPayoutById(id) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('creator_payout_requests').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchCreatorProfile(creatorId) {
  const { data } = await supabase
    .from('users')
    .select('email, username, display_name')
    .eq('id', creatorId)
    .maybeSingle();
  return data || {};
}

async function fetchRiskContext(creatorId, accountNumber) {
  const [historyRes, duplicateRes, balances] = await Promise.all([
    supabase
      .from('creator_payout_requests')
      .select('status,amount_usd,requested_at')
      .eq('creator_id', creatorId)
      .order('requested_at', { ascending: false })
      .limit(20),
    accountNumber
      ? supabase
          .from('creator_payout_requests')
          .select('creator_id')
          .eq('account_number', accountNumber)
          .neq('creator_id', creatorId)
          .limit(3)
      : Promise.resolve({ data: [] }),
    getCreatorPayoutBalances(creatorId),
  ]);

  return {
    history: historyRes.data || [],
    duplicateAccountCount: duplicateRes.data?.length || 0,
    balances,
  };
}

async function fallbackCreateWithdrawal(payload) {
  const { data, error } = await supabase
    .from('creator_payout_requests')
    .insert({
      creator_id: payload.creatorId,
      creator_name: payload.creatorName,
      creator_email: payload.creatorEmail,
      amount_usd: payload.amountUsd,
      amount_ngn: payload.amountNgn,
      bank_name: payload.bankName,
      bank_code: payload.bankCode,
      account_number: payload.accountNumber,
      account_name: payload.accountName,
      reference_id: payload.referenceId,
      method: payload.method,
      status: 'pending',
      risk_score: payload.riskScore,
      risk_flags: payload.riskFlags,
      locked_amount_usd: payload.amountUsd,
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createCreatorWithdrawalRequest({
  creatorId,
  amount,
  bankName,
  bankCode,
  accountNumber,
  accountName,
  req = null,
  io = null,
}) {
  if (!isConfigured() || !supabase) throw new Error('Database temporarily unavailable.');

  const amountUsd = money(amount);
  if (amountUsd <= 0) throw new Error('Invalid withdrawal amount.');
  if (!bankName?.trim()) throw new Error('Bank name is required.');
  if (!accountNumber?.trim()) throw new Error('Account number is required.');
  if (!accountName?.trim()) throw new Error('Account holder name is required.');

  const profile = await fetchCreatorProfile(creatorId);
  const riskContext = await fetchRiskContext(creatorId, accountNumber.trim());
  const { riskScore, riskFlags } = calculateRiskFlags({
    amountUsd,
    available: riskContext.balances.available,
    history: riskContext.history,
    duplicateAccountCount: riskContext.duplicateAccountCount,
  });

  if (amountUsd > riskContext.balances.available) {
    throw new Error(`Insufficient balance. Available: $${riskContext.balances.available.toFixed(2)}`);
  }

  let amountNgn = null;
  try {
    const rate = await getNgnToUsdRate();
    amountNgn = money(amountUsd * rate);
  } catch {
    amountNgn = null;
  }

  const referenceId = `XPAY-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const creatorName = profile.display_name || profile.username || accountName.trim();
  const creatorEmail = profile.email || null;
  const rpcPayload = {
    p_creator_id: creatorId,
    p_creator_name: creatorName,
    p_creator_email: creatorEmail,
    p_amount_usd: amountUsd,
    p_amount_ngn: amountNgn,
    p_bank_name: bankName.trim(),
    p_bank_code: bankCode?.trim() || null,
    p_account_number: accountNumber.trim(),
    p_account_name: accountName.trim(),
    p_reference_id: referenceId,
    p_method: 'bank_transfer',
    p_risk_score: riskScore,
    p_risk_flags: riskFlags,
  };

  let payout;
  const rpc = await supabase.rpc('request_creator_withdrawal', rpcPayload);
  if (rpc.error) {
    if (!isMissingDbFeature(rpc.error)) throw rpc.error;
    payout = await fallbackCreateWithdrawal({
      creatorId,
      creatorName,
      creatorEmail,
      amountUsd,
      amountNgn,
      bankName: bankName.trim(),
      bankCode: bankCode?.trim() || null,
      accountNumber: accountNumber.trim(),
      accountName: accountName.trim(),
      referenceId,
      method: 'bank_transfer',
      riskScore,
      riskFlags,
    });
  } else {
    payout = rpc.data;
  }

  await insertPayoutAudit({
    payout,
    action: 'creator_withdrawal_requested',
    actorId: creatorId,
    actorType: 'creator',
    toStatus: 'pending',
    metadata: { riskScore, riskFlags },
    req,
  });
  await invalidatePayoutCache();
  await writeFinancePayoutLog(payout, 'pending', { metadata: { source: 'creator_studio', riskScore, riskFlags } });
  emitPayoutRealtime(io, 'finance:payout-created', payout, { status: 'pending' });
  await enqueuePayoutNotification('submitted', payout);
  if (riskFlags.length) await enqueuePayoutWorkflow('/audit', { type: 'payout.high_risk', payoutId: payout.id, riskFlags, riskScore });

  return publicPayout(payout);
}

async function transitionPayout({ id, nextStatus, actorId = null, reason = null, transactionReference = null, proofUrl = null, metadata = {}, req = null }) {
  const before = await getPayoutById(id);
  if (!before) throw new Error('Payout not found.');

  let payout;
  const { data, error } = await supabase.rpc('transition_creator_payout_status', {
    p_payout_id: id,
    p_next_status: nextStatus,
    p_actor_id: actorId,
    p_reason: reason,
    p_transaction_reference: transactionReference,
    p_proof_url: proofUrl,
    p_metadata: metadata,
  });
  if (error) {
    if (!isMissingDbFeature(error)) throw error;
    const update = {
      status: nextStatus,
      processed_at: new Date().toISOString(),
      processed_by: actorId,
      transaction_reference: transactionReference,
      proof_url: proofUrl,
      updated_at: new Date().toISOString(),
    };
    if (nextStatus === 'rejected') update.rejection_reason = reason;
    if (nextStatus === 'failed') update.failure_reason = reason;
    if (nextStatus === 'approved') {
      update.approved_at = new Date().toISOString();
      update.approved_by = actorId;
    }
    if (nextStatus === 'completed' || nextStatus === 'paid') update.paid_at = new Date().toISOString();
    const result = await supabase.from('creator_payout_requests').update(update).eq('id', id).select().maybeSingle();
    if (result.error) throw result.error;
    payout = result.data;
  } else {
    payout = data;
  }

  await insertPayoutAudit({
    payout,
    action: `payout_${nextStatus}`,
    actorId,
    actorType: actorId ? 'admin' : 'system',
    fromStatus: before.status,
    toStatus: nextStatus,
    notes: reason,
    metadata,
    req,
  });
  await invalidatePayoutCache();

  return payout;
}

export function emitPayoutRealtime(io, eventName, payout, extra = {}) {
  emitFinancePayoutEvent(io, eventName, publicPayout(payout), extra);
  try {
    io?.to?.(`user:${payout.creator_id}`)?.emit?.('creator:payout-updated', {
      payout: publicPayout(payout),
      status: payout.status,
      ts: Date.now(),
    });
  } catch {}
}

export async function approvePayoutRequest({ id, admin, notes = '', financeAssigneeId = null, req = null, io = null }) {
  const payout = await transitionPayout({
    id,
    nextStatus: 'approved',
    actorId: admin?.id || null,
    reason: notes,
    metadata: { adminNotes: notes, financeAssigneeId },
    req,
  });

  const update = {
    admin_notes: notes || payout.admin_notes || null,
    finance_assignee_id: financeAssigneeId || payout.finance_assignee_id || null,
    finance_status: 'assigned',
    updated_at: new Date().toISOString(),
  };
  const { data: updated, error } = await supabase
    .from('creator_payout_requests')
    .update(update)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error && !isMissingDbFeature(error)) throw error;
  const nextPayout = updated || { ...payout, ...update };

  await writeFinancePayoutLog(nextPayout, 'approved', { metadata: { action: 'approved', adminId: admin?.id || null, notes } });
  await logAdminAction(req || { admin }, {
    admin,
    action: 'Approved creator payout',
    targetType: 'creator_payout',
    targetId: id,
    details: { amountUsd: nextPayout.amount_usd, creatorId: nextPayout.creator_id, notes },
  });
  emitPayoutRealtime(io, 'finance:payout-updated', nextPayout, { status: 'approved' });
  await enqueuePayoutNotification('approved', nextPayout);
  await enqueuePayoutWorkflow('/assign-finance', {
    type: 'payout.assign_finance',
    payoutId: id,
    financeAssigneeId,
  }, {
    delaySeconds: readPositiveInteger('QSTASH_PAYOUT_ASSIGN_DELAY_SECONDS', 30),
  });

  return publicPayout(nextPayout);
}

export async function assignApprovedPayoutToFinance({ id, financeAssigneeId = null, io = null }) {
  const payout = await transitionPayout({
    id,
    nextStatus: 'processing',
    actorId: financeAssigneeId,
    metadata: { source: 'qstash_finance_assignment', financeAssigneeId },
  });
  await writeFinancePayoutLog(payout, 'processing', { metadata: { action: 'finance_assigned', financeAssigneeId } });
  await enqueuePayoutNotification('processing', payout);
  emitPayoutRealtime(io, 'finance:payout-updated', payout, { status: 'processing' });
  return publicPayout(payout);
}

export async function rejectPayoutRequest({ id, admin, reason, req = null, io = null }) {
  if (!String(reason || '').trim()) throw new Error('Rejection reason is required.');
  const payout = await transitionPayout({
    id,
    nextStatus: 'rejected',
    actorId: admin?.id || null,
    reason: String(reason).trim().slice(0, 1000),
    metadata: { action: 'rejected', adminId: admin?.id || null },
    req,
  });
  try {
    await createPayoutReceipt({ ...payout, rejection_reason: reason }, 'rejected', { adminId: admin?.id || null });
  } catch (err) {
    console.warn('[payout] rejection receipt failed:', err.message);
  }
  await writeFinancePayoutLog(payout, 'rejected', { errorMessage: reason, metadata: { adminId: admin?.id || null } });
  await logAdminAction(req || { admin }, {
    admin,
    action: 'Rejected creator payout',
    targetType: 'creator_payout',
    targetId: id,
    details: { reason, creatorId: payout.creator_id, amountUsd: payout.amount_usd },
  });
  emitPayoutRealtime(io, 'finance:payout-updated', payout, { status: 'rejected' });
  await enqueuePayoutNotification('rejected', payout);
  return publicPayout(payout);
}

export async function markPayoutProcessing({ id, admin, transactionReference = null, notes = '', req = null, io = null }) {
  const payout = await transitionPayout({
    id,
    nextStatus: 'processing',
    actorId: admin?.id || null,
    reason: notes,
    transactionReference,
    metadata: { action: 'manual_processing', notes },
    req,
  });
  await insertPayoutTransaction({ payout, status: 'processing', reference: transactionReference, actorId: admin?.id || null, metadata: { notes } });
  await writeFinancePayoutLog(payout, 'processing', { transactionReference, metadata: { action: 'manual_processing', adminId: admin?.id || null } });
  emitPayoutRealtime(io, 'finance:payout-updated', payout, { status: 'processing' });
  await enqueuePayoutNotification('processing', payout);
  return publicPayout(payout);
}

export async function markPayoutCompleted({ id, admin, transactionReference = null, proofUrl = null, provider = 'manual', notes = '', req = null, io = null }) {
  const ref = transactionReference || `PAY-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const payout = await transitionPayout({
    id,
    nextStatus: 'completed',
    actorId: admin?.id || null,
    reason: notes,
    transactionReference: ref,
    proofUrl,
    metadata: { action: 'manual_completion', provider, notes },
    req,
  });
  let receipt = null;
  try {
    receipt = await createPayoutReceipt(
      { ...payout, transaction_reference: payout.transaction_reference || ref },
      'paid',
      { adminId: admin?.id || null },
    );
  } catch (err) {
    console.warn('[payout] paid receipt failed:', err.message);
  }
  await insertPayoutTransaction({ payout, status: 'completed', provider, reference: transactionReference, proofUrl, actorId: admin?.id || null, metadata: { notes } });
  await writeFinancePayoutLog(payout, 'completed', { provider, transactionReference, paymentDate: new Date().toISOString(), metadata: { action: 'completed', adminId: admin?.id || null } });
  await logAdminAction(req || { admin }, {
    admin,
    action: 'Completed creator payout',
    targetType: 'creator_payout',
    targetId: id,
    details: { transactionReference, proofUrl, provider },
  });
  emitPayoutRealtime(io, 'finance:payout-updated', payout, { status: 'completed' });
  await enqueuePayoutNotification('completed', payout);
  return { ...publicPayout(payout), receiptId: receipt?.id || null, receiptNumber: receipt?.receiptNumber || payout.receipt_number || null };
}

export async function markPayoutFailed({ id, admin, reason, req = null, io = null }) {
  if (!String(reason || '').trim()) throw new Error('Failure reason is required.');
  const payout = await transitionPayout({
    id,
    nextStatus: 'failed',
    actorId: admin?.id || null,
    reason: String(reason).trim().slice(0, 1000),
    metadata: { action: 'failed' },
    req,
  });
  await insertPayoutTransaction({ payout, status: 'failed', errorMessage: reason, actorId: admin?.id || null });
  await writeFinancePayoutLog(payout, 'failed', { errorMessage: reason, metadata: { adminId: admin?.id || null } });
  emitPayoutRealtime(io, 'finance:payout-updated', payout, { status: 'failed' });
  await enqueuePayoutNotification('failed', payout);
  return publicPayout(payout);
}

export async function retryFailedPayout({ id, admin, req = null, io = null }) {
  const payout = await transitionPayout({
    id,
    nextStatus: 'processing',
    actorId: admin?.id || null,
    metadata: { action: 'retry_failed_payout' },
    req,
  });
  await insertPayoutTransaction({ payout, status: 'retrying', actorId: admin?.id || null });
  await writeFinancePayoutLog(payout, 'processing', { metadata: { action: 'retry', adminId: admin?.id || null } });
  emitPayoutRealtime(io, 'finance:payout-updated', payout, { status: 'processing' });
  await enqueuePayoutWorkflow('/verify', { type: 'payout.verify', payoutId: id }, { delaySeconds: 60 });
  return publicPayout(payout);
}

export async function getPayoutAnalytics() {
  if (!supabase) return {};
  const cached = await readCache(PAYOUT_ANALYTICS_CACHE_KEY);
  if (cached) return cached;

  const { data: rows, error } = await supabase
    .from('creator_payout_requests')
    .select('amount_usd,status,requested_at,processed_at,completed_at,paid_at,risk_score');
  if (error) throw error;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const daily = new Map();
  const summary = {
    totalPayouts: 0,
    pendingPayouts: 0,
    approvedPayouts: 0,
    processingPayouts: 0,
    completedPayouts: 0,
    failedPayouts: 0,
    rejectedPayouts: 0,
    highRiskCount: 0,
    completedThisMonth: 0,
    avgProcessingHours: 0,
  };
  const durations = [];

  for (const row of rows || []) {
    const amount = Number(row.amount_usd || 0);
    summary.totalPayouts += amount;
    if (row.status === 'pending') summary.pendingPayouts += amount;
    if (row.status === 'approved') summary.approvedPayouts += amount;
    if (row.status === 'processing') summary.processingPayouts += amount;
    if (['paid', 'completed'].includes(row.status)) summary.completedPayouts += amount;
    if (row.status === 'failed') summary.failedPayouts += amount;
    if (row.status === 'rejected') summary.rejectedPayouts += amount;
    if (Number(row.risk_score || 0) >= 50) summary.highRiskCount += 1;

    const finishedAt = row.completed_at || row.paid_at || row.processed_at;
    if (['paid', 'completed'].includes(row.status) && finishedAt) {
      const finishedMs = new Date(finishedAt).getTime();
      if (finishedMs >= monthStart) summary.completedThisMonth += amount;
      const requestedMs = new Date(row.requested_at).getTime();
      if (Number.isFinite(requestedMs) && Number.isFinite(finishedMs) && finishedMs >= requestedMs) {
        durations.push((finishedMs - requestedMs) / 36e5);
      }
    }

    const day = String(row.requested_at || '').slice(0, 10);
    if (day) daily.set(day, (daily.get(day) || 0) + amount);
  }

  summary.avgProcessingHours = durations.length
    ? Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 10) / 10
    : 0;

  const result = {
    ...summary,
    daily: Array.from(daily.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, amount })),
  };
  await writeCache(PAYOUT_ANALYTICS_CACHE_KEY, result, readPositiveInteger('PAYOUT_ANALYTICS_CACHE_TTL_SECONDS', 30));
  return result;
}

export async function generatePayoutDailySummary(date = new Date()) {
  if (!supabase) return { success: false, reason: 'Supabase not configured.' };
  const day = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  const { data, error } = await supabase.rpc('refresh_payout_daily_summary', { p_summary_date: day });
  if (error) {
    if (!isMissingDbFeature(error)) throw error;
    return { success: false, missingMigration: true, error: error.message };
  }
  return { success: true, summary: data };
}

export async function runDuePayoutVerification({ io = null } = {}) {
  if (!supabase) return { success: false, reason: 'Supabase not configured.' };
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('creator_payout_requests')
    .select('*')
    .in('status', ['processing', 'paid'])
    .lt('processed_at', cutoff)
    .limit(100);
  if (error) throw error;

  let flagged = 0;
  for (const payout of data || []) {
    await supabase.from('finance_notifications').insert({
      role: 'finance',
      type: 'payout_requires_review',
      title: 'Payout requires review',
      message: `${payout.creator_name || 'Creator'} payout has been processing for over 24 hours.`,
      data: { payoutId: payout.id, referenceId: payout.reference_id },
    });
    emitPayoutRealtime(io, 'finance:payout-updated', payout, { status: payout.status, requiresReview: true });
    flagged += 1;
  }

  return { success: true, flagged };
}
