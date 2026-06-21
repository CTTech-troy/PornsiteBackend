import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { createGzip } from 'zlib';
import { supabase } from '../config/supabase.js';
import { isConfigured, getPublicUrl } from '../config/supabase.js';
import {
  sendPayoutApprovedEmail,
  sendPayoutPaidEmail,
  sendPayoutRejectedEmail,
} from '../services/emailService.js';
import { getNgnToUsdRate } from '../utils/exchangeRate.js';
import { processCreatorPayoutTransfer } from '../services/paystackTransfer.service.js';
import { getBooleanSetting } from '../services/platformSettings.service.js';
import {
  emitFinancePayoutEvent,
  listFinanceActivityEvents,
  writeFinanceActivityEvent,
  subscribeFinanceEvents,
  writeFinancePayoutLog,
} from '../services/financePayoutEvents.service.js';
import {
  approvePayoutRequest,
  getCreatorPayoutBalances,
  getPayoutById,
  markPayoutCompleted,
  markPayoutFailed,
  markPayoutProcessing,
  rejectPayoutRequest,
  retryFailedPayout,
} from '../services/payoutWorkflow.service.js';
import { getPayoutAnalyticsWithRange, getPayoutMetrics } from '../services/payoutMetricsService.js';
import { getCompanyRevenueMetrics, getUnifiedFinanceDashboard } from '../services/revenueMetricsService.js';
import { getUserEarningsSummary } from '../services/revenueCalculation.service.js';
import { getRevenueSettingsAuditHistory } from '../services/platformSettingsAudit.service.js';
import { getRevenueSettingsPayload, saveAdminSettings } from '../services/platformSettings.service.js';
import { getAdRewardAnalytics } from '../services/creatorAdReward.service.js';
import { resolveRange } from '../services/revenueCalculation.service.js';
import { getStringSetting } from '../services/platformSettings.service.js';
import { getReceiptForPayout, streamReceiptPdf } from '../services/receiptService.js';
import { normalizeCreatorApplicationKyc } from '../services/payoutKyc.service.js';
import {
  getFraudAlerts,
  getGatewayAnalytics,
  getPaymentAuditTrail,
  getPaymentMonitoring,
  getPaymentReconciliationReport,
  getWebhookEvents,
} from '../services/securePayments.service.js';
import {
  getPaymentHistory,
  getPaymentHistoryExport,
  paymentHistoryToExcelXml,
  streamPaymentHistoryCsvGzip,
  streamPaymentHistoryPdf,
} from '../services/paymentHistory.service.js';
import { getGatewayHealth } from '../services/paymentServiceClient.js';
import { processCreatorFlutterwavePayoutTransfer } from '../services/flutterwaveTransfer.service.js';
import {
  adsSchemaMissingPayload,
  isAdsTableMissing,
  missingAdsColumnName,
  tryNotifyPgrstReloadSchema,
} from '../utils/supabaseAdsErrors.js';

export { subscribeFinanceEvents };

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(v) { return Number(v) || 0; }

function paginate(page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
}

// PostgREST returns PGRST200 when a table is missing from its schema cache.
// Postgres itself returns 42P01. Handle both.
function isMissingTable(err) {
  if (!err) return false;
  return (
    err.code === '42P01' ||
    err.code === 'PGRST200' ||
    (typeof err.message === 'string' && err.message.includes('schema cache'))
  );
}

function isMissingColumn(err) {
  return err?.code === '42703';
}

function isStatusConstraintError(err) {
  return err?.code === '23514' && /status/i.test(err?.message || '');
}

function publicPayoutLogFromRequest(row) {
  return {
    id: `payout-${row.id}`,
    payout_request_id: row.id,
    creator_id: row.creator_id,
    creator_name: row.creator_name || row.account_name || null,
    amount_usd: fmt(row.amount_usd),
    amount_ngn: row.amount_ngn == null ? null : fmt(row.amount_ngn),
    transaction_reference: row.paystack_transaction_reference || row.reference_id || null,
    payout_status: row.status || 'pending',
    payment_date: row.paid_at || row.processed_at || row.requested_at,
    provider: row.payment_provider || 'paystack',
    error_message: row.failure_reason || row.rejection_reason || null,
    created_at: row.processed_at || row.requested_at,
  };
}

async function updatePayoutStatus(id, payload, options = {}) {
  const statuses = options.statuses || null;
  let query = supabase.from('creator_payout_requests').update(payload).eq('id', id);
  if (statuses?.length) query = query.in('status', statuses);
  const result = await query.select().maybeSingle();

  if ((isMissingColumn(result.error) || isStatusConstraintError(result.error)) && options.fallbackPayload) {
    let fallback = supabase.from('creator_payout_requests').update(options.fallbackPayload).eq('id', id);
    if (statuses?.length) fallback = fallback.in('status', statuses);
    return fallback.select().maybeSingle();
  }

  return result;
}

async function resolvePayoutNgnAmount(payout) {
  const current = Number(payout.amount_ngn || 0);
  if (current > 0) return current;
  const rate = await getNgnToUsdRate();
  return parseFloat((Number(payout.amount_usd || 0) * rate).toFixed(2));
}

// PostgREST returns PGRST103 when .range() is beyond the total row count.
function isRangeError(err) {
  return err?.code === 'PGRST103';
}

// ── GET /api/admin/finance/summary ───────────────────────────────────────────

export async function getFinanceActivityAdmin(req, res) {
  try {
    const result = await listFinanceActivityEvents({
      page: req.query.page,
      limit: req.query.limit,
      eventType: req.query.eventType,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to load finance activity.' });
  }
}

export async function getFinanceSummary(req, res) {
  try {
    const paymentHistory = await getPaymentHistory({ page: 1, limit: 10, paymentType: 'coin_purchase' });
    const totalRevenue = fmt(paymentHistory?.stats?.totalRevenue);

    const { data: gifts } = await supabase
      .from('creator_earnings')
      .select('amount_usd')
      .eq('source', 'live_gift');
    const liveGiftRevenue = (gifts || []).reduce((s, r) => s + fmt(r.amount_usd), 0);

    // Optional tables — degrade silently when they don't exist yet
    let pendingPayouts = 0;
    const { data: payouts, error: payoutsErr } = await supabase
      .from('creator_payout_requests')
      .select('amount_usd')
      .eq('status', 'pending');
    if (!isMissingTable(payoutsErr)) {
      pendingPayouts = (payouts || []).reduce((s, r) => s + fmt(r.amount_usd), 0);
    }

    let adRevenue = 0;
    const { data: ads, error: adsErr } = await supabase
      .from('ad_campaigns')
      .select('revenue_usd');
    if (!isMissingTable(adsErr)) {
      adRevenue = (ads || []).reduce((s, r) => s + fmt(r.revenue_usd), 0);
    }

    const recentRows = paymentHistory?.records || [];

    let payoutLogs = [];
    const { data: financeLogs, error: financeLogsErr } = await supabase
      .from('finance_payout_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    if (!isMissingTable(financeLogsErr) && !isMissingColumn(financeLogsErr)) {
      payoutLogs = financeLogs || [];
    } else {
      const { data: fallbackPayoutLogs, error: fallbackPayoutErr } = await supabase
        .from('creator_payout_requests')
        .select('id, creator_id, creator_name, amount_usd, amount_ngn, status, reference_id, processed_at, requested_at, rejection_reason')
        .order('requested_at', { ascending: false })
        .limit(20);
      if (!fallbackPayoutErr) payoutLogs = (fallbackPayoutLogs || []).map(publicPayoutLogFromRequest);
    }

    return res.json({
      totalRevenue,
      pendingPayouts,
      liveGiftRevenue,
      adRevenue,
      recentTransactions: recentRows.map(t => ({
        id: t.id,
        type: 'Coin purchase',
        userId: t.userId,
        userName: t.userName || null,
        amount: fmt(t.amountUsd),
        method: t.provider || 'Unknown',
        status: t.status || 'unknown',
        date: t.date,
      })),
      payoutLogs,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/finance/payments ──────────────────────────────────────────

export async function getPaymentHistoryAdmin(req, res) {
  try {
    const result = await getPaymentHistory(req.query);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[payment-history] load failed:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to load payment history.',
    });
  }
}

export async function exportPaymentHistoryCsv(req, res) {
  try {
    const { records } = await getPaymentHistoryExport(req.query);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="payment-history-${new Date().toISOString().slice(0, 10)}.csv.gz"`);
    return streamPaymentHistoryCsvGzip(res, records);
  } catch (err) {
    console.error('[payment-history] csv export failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to export payment history CSV.' });
  }
}

export async function exportPaymentHistoryExcel(req, res) {
  try {
    const { records } = await getPaymentHistoryExport(req.query);
    const xml = paymentHistoryToExcelXml(records);
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payment-history-${new Date().toISOString().slice(0, 10)}.xls"`);
    return res.send(xml);
  } catch (err) {
    console.error('[payment-history] excel export failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to export payment history Excel file.' });
  }
}

export async function exportPaymentHistoryPdf(req, res) {
  try {
    const { records, stats } = await getPaymentHistoryExport(req.query);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payment-history-${new Date().toISOString().slice(0, 10)}.pdf"`);
    return streamPaymentHistoryPdf(res, records, stats);
  } catch (err) {
    console.error('[payment-history] pdf export failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to export payment history PDF.' });
  }
}

export async function getPaymentsAdmin(req, res) {
  try {
    const securePayments = await getPaymentMonitoring(req.query);
    if (securePayments) return res.json(securePayments);

    const result = await getPaymentHistory({
      ...req.query,
      paymentType: req.query.paymentType || req.query.type || 'coin_purchase',
    });
    const payments = (result.records || []).map((row) => ({
      id: row.id,
      reference: row.transactionId,
      userId: row.userId,
      name: row.userName || `User ${String(row.userId || '').slice(0, 6)}`,
      email: row.userEmail || '',
      item: row.item,
      amount: fmt(row.amountUsd),
      method: row.provider || 'coin_wallet',
      status: row.status,
      date: row.date,
    }));

    return res.json({ payments, total: result.total, page: result.page, limit: result.limit, stats: result.stats });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/finance/payouts ────────────────────────────────────────────

const EMPTY_PAYOUT_STATS = {
  pendingTotal: 0,
  approvedTotal: 0,
  processingTotal: 0,
  completedTotal: 0,
  failedTotal: 0,
  processedThisMonth: 0,
  totalCreatorBalances: 0,
  avgPayout: 0,
  highRiskCount: 0,
};

export async function getCreatorPayoutsAdmin(req, res) {
  try {
    const { search = '', statusFilter = '', methodFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    // Count first — also validates the table exists
    let countQuery = supabase
      .from('creator_payout_requests')
      .select('*', { count: 'exact', head: true });
    if (statusFilter) countQuery = countQuery.eq('status', statusFilter);
    if (methodFilter) countQuery = countQuery.ilike('method', `%${methodFilter}%`);
    if (search) countQuery = countQuery.or(`creator_name.ilike.%${search}%,creator_email.ilike.%${search}%`);

    const { count, error: countErr } = await countQuery;

    if (isMissingTable(countErr)) {
      return res.json({ payouts: [], total: 0, page, limit, stats: EMPTY_PAYOUT_STATS });
    }
    if (countErr) return res.status(500).json({ message: countErr.message });

    const total = count || 0;

    // Earnings for stats (always available)
    const { data: earnings } = await supabase.from('creator_earnings').select('amount_usd');
    const totalCreatorBalances = (earnings || []).reduce((s, r) => s + fmt(r.amount_usd), 0);

    if (total === 0 || offset >= total) {
      return res.json({ payouts: [], total, page, limit, stats: { ...EMPTY_PAYOUT_STATS, totalCreatorBalances } });
    }

    let query = supabase.from('creator_payout_requests').select('*');
    if (statusFilter) query = query.eq('status', statusFilter);
    if (methodFilter) query = query.ilike('method', `%${methodFilter}%`);
    if (search) query = query.or(`creator_name.ilike.%${search}%,creator_email.ilike.%${search}%`);
    query = query.order('requested_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data: rows, error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    // Stats
    const { data: allPayouts } = await supabase
      .from('creator_payout_requests')
      .select('amount_usd, status, requested_at, processed_at, risk_score');

    const pendingTotal = (allPayouts || [])
      .filter(r => r.status === 'pending')
      .reduce((s, r) => s + fmt(r.amount_usd), 0);
    const approvedTotal = (allPayouts || [])
      .filter(r => r.status === 'approved')
      .reduce((s, r) => s + fmt(r.amount_usd), 0);
    const processingTotal = (allPayouts || [])
      .filter(r => r.status === 'processing')
      .reduce((s, r) => s + fmt(r.amount_usd), 0);
    const completedTotal = (allPayouts || [])
      .filter(r => ['paid', 'completed'].includes(r.status))
      .reduce((s, r) => s + fmt(r.amount_usd), 0);
    const failedTotal = (allPayouts || [])
      .filter(r => r.status === 'failed')
      .reduce((s, r) => s + fmt(r.amount_usd), 0);
    const highRiskCount = (allPayouts || []).filter(r => Number(r.risk_score || 0) >= 50).length;

    const currentMonth = new Date();
    const monthStart = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getTime();
    const completed = (allPayouts || []).filter((r) => {
      if (!['paid', 'completed'].includes(r.status)) return false;
      const ts = r.processed_at || r.requested_at;
      return ts ? new Date(ts).getTime() >= monthStart : true;
    });
    const processedThisMonth = completed.reduce((s, r) => s + fmt(r.amount_usd), 0);
    const avgPayout = completed.length ? processedThisMonth / completed.length : 0;

    return res.json({
      payouts: rows || [],
      total,
      page,
      limit,
      stats: { pendingTotal, approvedTotal, processingTotal, completedTotal, failedTotal, processedThisMonth, totalCreatorBalances, avgPayout, highRiskCount },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/payouts/:id/approve ───────────────────────────────

export async function approveCreatorPayout(req, res) {
  try {
    const { id } = req.params;
    const payout = await approvePayoutRequest({
      id,
      admin: req.admin,
      notes: req.body?.notes || req.body?.adminNotes || '',
      financeAssigneeId: req.body?.financeAssigneeId || null,
      req,
      io: req.app?.get('io'),
    });
    return res.json({ message: 'Payout approved and assigned to finance workflow.', payout });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/payouts/:id/mark-paid ─────────────────────────────

const markPaidIdempotency = new Map();

export async function markPayoutPaid(req, res) {
  try {
    const { id } = req.params;
    const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
    if (idempotencyKey) {
      const cached = markPaidIdempotency.get(`${id}:${idempotencyKey}`);
      if (cached) return res.json(cached);
    }

    const {
      transactionReference = null,
      proofUrl = null,
      provider = 'manual',
      notes = '',
      useGateway = false,
    } = req.body || {};

    if (!useGateway) {
      if (!String(transactionReference || '').trim() && !proofUrl) {
        return res.status(400).json({ message: 'Transaction reference or proof is required for manual payout completion.' });
      }
      const payout = await markPayoutCompleted({
        id,
        admin: req.admin,
        transactionReference,
        proofUrl,
        provider,
        notes,
        req,
        io: req.app?.get('io'),
      });
      const body = { message: 'Payout marked completed.', payout };
      if (idempotencyKey) markPaidIdempotency.set(`${id}:${idempotencyKey}`, body);
      return res.json(body);
    }

    const automationEnabled = await getBooleanSetting('creator_payout_automation_enabled', true);
    if (!automationEnabled) {
      return res.status(403).json({ message: 'Creator payout automation is disabled in Platform Settings.' });
    }
    const { data: payout, error: fetchError } = await supabase
      .from('creator_payout_requests')
      .select('*')
      .eq('id', id)
      .in('status', ['approved', 'processing'])
      .maybeSingle();

    if (fetchError) return res.status(500).json({ message: fetchError.message });
    if (!payout) return res.status(404).json({ message: 'Payout not found or not payable.' });

    const gatewayProvider = String(provider || 'flutterwave').toLowerCase() === 'paystack' ? 'paystack' : 'flutterwave';
    const amountNgn = await resolvePayoutNgnAmount(payout);
    const gatewayReference = `${gatewayProvider === 'paystack' ? 'XST' : 'XFLW'}-PAYOUT-${String(payout.reference_id || payout.id).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}`;

    const processingPayout = await markPayoutProcessing({
      id,
      admin: req.admin,
      transactionReference: gatewayReference,
      notes: `${gatewayProvider === 'paystack' ? 'Paystack' : 'Flutterwave'} transfer started`,
      req,
      io: req.app?.get('io'),
    });

    let transfer;
    try {
      transfer = gatewayProvider === 'paystack'
        ? await processCreatorPayoutTransfer({
            ...processingPayout,
            amount_ngn: amountNgn,
            paystack_reference: gatewayReference,
          })
        : await processCreatorFlutterwavePayoutTransfer({
            ...processingPayout,
            amount_ngn: amountNgn,
            flutterwave_reference: gatewayReference,
          });
    } catch (transferError) {
      const failedPayout = await markPayoutFailed({
        id,
        admin: req.admin,
        reason: transferError.message || `${gatewayProvider} transfer failed.`,
        req,
        io: req.app?.get('io'),
      });
      return res.status(502).json({
        message: transferError.message || `${gatewayProvider} transfer failed. Payout has been marked as failed.`,
        payout: failedPayout,
      });
    }

    if (gatewayProvider === 'flutterwave' && transfer.status !== 'completed') {
      const { data: updated } = await updatePayoutStatus(id, {
        amount_ngn: amountNgn,
        payment_provider: 'flutterwave',
        flutterwave_transfer_id: transfer.id,
        flutterwave_transaction_reference: transfer.reference,
        flutterwave_status: transfer.status,
        transaction_reference: transfer.reference,
        payment_metadata: {
          flutterwaveStatus: transfer.status,
          flutterwaveTransferId: transfer.id,
          raw: transfer.raw,
        },
      }, {
        statuses: ['processing'],
      });
      const pendingPayout = updated || processingPayout;
      await writeFinancePayoutLog(pendingPayout, 'processing', {
        provider: 'flutterwave',
        transactionReference: transfer.reference,
        metadata: { action: 'flutterwave_transfer_started', transferId: transfer.id, status: transfer.status },
      });
      await writeFinanceActivityEvent({
        eventType: 'payout_processing',
        creatorId: pendingPayout.creator_id,
        amountUsd: pendingPayout.amount_usd,
        provider: 'flutterwave',
        reference: transfer.reference,
        status: transfer.status,
        metadata: { transferId: transfer.id },
      }, { io: req.app?.get('io') });
      return res.json({ message: 'Flutterwave payout transfer started. Awaiting provider confirmation.', payout: pendingPayout });
    }

    const completedPayout = await markPayoutCompleted({
      id,
      admin: req.admin,
      transactionReference: transfer.reference,
      provider: gatewayProvider,
      notes: `${gatewayProvider === 'paystack' ? 'Paystack' : 'Flutterwave'} transfer success`,
      req,
      io: req.app?.get('io'),
    });

    const providerPatch = gatewayProvider === 'paystack'
      ? {
          paystack_recipient_code: transfer.recipientCode,
          paystack_transfer_code: transfer.transferCode,
          paystack_transaction_reference: transfer.reference,
          payment_metadata: {
            paystackStatus: transfer.status,
            transferCode: transfer.transferCode,
          },
        }
      : {
          flutterwave_transfer_id: transfer.id,
          flutterwave_transaction_reference: transfer.reference,
          flutterwave_status: transfer.status,
          payment_metadata: {
            flutterwaveStatus: transfer.status,
            flutterwaveTransferId: transfer.id,
            raw: transfer.raw,
          },
        };

    await updatePayoutStatus(id, {
      amount_ngn: amountNgn,
      payment_provider: gatewayProvider,
      ...providerPatch,
    }, {
      statuses: ['completed'],
    });

    return res.json({ message: `Payout paid successfully through ${gatewayProvider === 'paystack' ? 'Paystack' : 'Flutterwave'}.`, payout: completedPayout });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/payouts/:id/reject ────────────────────────────────

export async function rejectCreatorPayout(req, res) {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body;
    const payout = await rejectPayoutRequest({
      id,
      admin: req.admin,
      reason,
      req,
      io: req.app?.get('io'),
    });
    return res.json({ message: 'Payout rejected and creator balance restored.', payout });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/finance/ads ────────────────────────────────────────────────

export async function markPayoutProcessingAdmin(req, res) {
  try {
    const payout = await markPayoutProcessing({
      id: req.params.id,
      admin: req.admin,
      transactionReference: req.body?.transactionReference || null,
      notes: req.body?.notes || '',
      req,
      io: req.app?.get('io'),
    });
    return res.json({ message: 'Payout marked as processing.', payout });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function markPayoutFailedAdmin(req, res) {
  try {
    const payout = await markPayoutFailed({
      id: req.params.id,
      admin: req.admin,
      reason: req.body?.reason || req.body?.failureReason || '',
      req,
      io: req.app?.get('io'),
    });
    return res.json({ message: 'Payout marked as failed and creator balance restored.', payout });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function retryPayoutAdmin(req, res) {
  try {
    const payout = await retryFailedPayout({
      id: req.params.id,
      admin: req.admin,
      req,
      io: req.app?.get('io'),
    });
    return res.json({ message: 'Payout retry queued.', payout });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function uploadPayoutProof(req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: 'Proof file is required.' });
    if (!isConfigured() || !supabase) return res.status(503).json({ message: 'Storage not configured.' });

    const bucket = process.env.SUPABASE_PAYOUT_PROOF_BUCKET || process.env.SUPABASE_IMAGE_BUCKET || 'images';
    const ext = String(req.file.originalname || '').split('.').pop()?.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const path = `payout-proofs/${req.params.id}/${Date.now()}-${randomUUID()}.${ext.slice(0, 10)}`;

    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype || 'application/octet-stream',
        upsert: false,
      });
    if (error) throw error;

    const proofUrl = getPublicUrl(bucket, path);
    const payout = await markPayoutCompleted({
      id: req.params.id,
      admin: req.admin,
      transactionReference: req.body?.transactionReference || null,
      proofUrl,
      provider: req.body?.provider || 'manual',
      notes: req.body?.notes || 'Proof of payment uploaded',
      req,
      io: req.app?.get('io'),
    });

    return res.json({ message: 'Proof uploaded and payout completed.', proofUrl, payout });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getPayoutAnalyticsAdmin(req, res) {
  try {
    const analytics = await getPayoutAnalyticsWithRange(req.query);
    return res.json({ analytics });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getFinanceDashboardMetrics(req, res) {
  try {
    const metrics = await getUnifiedFinanceDashboard(req.query);
    return res.json({ metrics });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getCompanyRevenue(req, res) {
  try {
    const company = await getCompanyRevenueMetrics(req.query);
    return res.json({ company });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getAdRewardAnalyticsAdmin(req, res) {
  try {
    const timezone = await getStringSetting('timezone', 'UTC');
    const { from, to } = resolveRange(req.query, timezone);
    const analytics = await getAdRewardAnalytics({ from, to });
    return res.json({ analytics });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getCreatorEarningsAdmin(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ message: 'userId required.' });
    const summary = await getUserEarningsSummary(userId);
    return res.json({ earnings: summary });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getRevenueSettingsAdmin(req, res) {
  try {
    const payload = await getRevenueSettingsPayload();
    const history = await getRevenueSettingsAuditHistory(40);
    return res.json({ ...payload, history });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function saveRevenueSettingsAdmin(req, res) {
  try {
    const { settings } = req.body || {};
    const admin = req.adminUser || { name: req.admin?.email || 'Admin', id: req.admin?.id };
    const result = await saveAdminSettings(settings, admin);
    return res.json({ message: 'Revenue settings saved.', ...result });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: err.message, errors: err.errors });
  }
}

export async function getPremiumPurchasesAdmin(req, res) {
  try {
    if (!supabase) return res.json({ purchases: [], total: 0 });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const { data, error, count } = await supabase
      .from('premium_video_purchases')
      .select('*', { count: 'exact' })
      .order('purchased_at', { ascending: false })
      .range(from, to);
    if (error) return res.json({ purchases: [], total: 0 });
    return res.json({ purchases: data || [], total: count || 0, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getRevenueSettingsHistoryAdmin(req, res) {
  try {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const history = await getRevenueSettingsAuditHistory(limit);
    return res.json({ history });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getCreatorPayoutDetail(req, res) {
  try {
    const { id } = req.params;
    const payout = await getPayoutById(id);
    if (!payout) return res.status(404).json({ message: 'Payout not found.' });

    const [balances, auditRes, ledgerRes, historyRes, receiptRes, userRes, appRes] = await Promise.all([
      getCreatorPayoutBalances(payout.creator_id).catch(() => null),
      supabase.from('payout_audit_logs').select('*').eq('payout_request_id', id).order('created_at', { ascending: false }).limit(50),
      supabase.from('creator_wallet_ledger').select('*').eq('creator_id', payout.creator_id).order('created_at', { ascending: false }).limit(30),
      supabase
        .from('creator_payout_requests')
        .select('id,amount_usd,amount_ngn,status,requested_at,receipt_number,reference_id,bank_name,rejection_reason,failure_reason,processed_at,paid_at')
        .eq('creator_id', payout.creator_id)
        .order('requested_at', { ascending: false })
        .limit(20),
      getReceiptForPayout(id),
      supabase.from('users').select('id,email,username,display_name,phone,avatar_url,status').eq('id', payout.creator_id).maybeSingle(),
      supabase.from('creator_applications').select('*').eq('user_id', payout.creator_id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);

    const creator = userRes.data || null;
    const application = appRes.error && isMissingTable(appRes.error) ? null : (appRes.data || null);

    return res.json({
      payout,
      creator,
      application,
      kyc: normalizeCreatorApplicationKyc(application, creator),
      balances,
      auditLog: auditRes.error && isMissingTable(auditRes.error) ? [] : (auditRes.data || []),
      walletLedger: ledgerRes.error && isMissingTable(ledgerRes.error) ? [] : (ledgerRes.data || []),
      withdrawalHistory: historyRes.data || [],
      receipt: receiptRes || null,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getPayoutReceiptAdmin(req, res) {
  try {
    const payout = await getPayoutById(req.params.id);
    if (!payout) return res.status(404).json({ message: 'Payout not found.' });
    const receipt = await getReceiptForPayout(req.params.id, req.query.type || null);
    if (!receipt) return res.status(404).json({ message: 'Receipt not found.' });
    if (req.path.endsWith('.pdf') || req.query.format === 'pdf') {
      return streamReceiptPdf(res, receipt, receipt.metadata);
    }
    return res.json({ receipt, payout });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function exportPayoutsCsv(req, res) {
  try {
    const { data, error } = await supabase
      .from('creator_payout_requests')
      .select('reference_id,creator_id,creator_name,creator_email,amount_usd,amount_ngn,bank_name,account_name,status,requested_at,processed_at,paid_at,completed_at,transaction_reference')
      .order('requested_at', { ascending: false })
      .limit(5000);
    if (error) throw error;

    const headers = ['reference_id', 'creator_id', 'creator_name', 'creator_email', 'amount_usd', 'amount_ngn', 'bank_name', 'account_name', 'status', 'requested_at', 'processed_at', 'paid_at', 'completed_at', 'transaction_reference'];
    const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    function* lines() {
      yield `${headers.join(',')}\n`;
      for (const row of data || []) {
        yield `${headers.map((key) => escapeCsv(row[key])).join(',')}\n`;
      }
    }

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="creator-payouts-${new Date().toISOString().slice(0, 10)}.csv.gz"`);
    return Readable.from(lines()).pipe(createGzip()).pipe(res);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

const EMPTY_AD_RESPONSE = { campaigns: [], stats: { activeCampaigns: 0, totalImpressions: 0, adRevenue: 0 } };

export async function getAdCampaigns(req, res) {
  try {
    let { data: campaigns, error } = await supabase
      .from('ad_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (isAdsTableMissing(error)) {
      await tryNotifyPgrstReloadSchema(supabase);
      const retry = await supabase
        .from('ad_campaigns')
        .select('*')
        .order('created_at', { ascending: false });
      campaigns = retry.data;
      error = retry.error;
    }

    if (isAdsTableMissing(error)) {
      return res.json({ ...EMPTY_AD_RESPONSE, ...adsSchemaMissingPayload() });
    }
    if (error) return res.status(500).json({ message: error.message });

    const active = (campaigns || []).filter(c => c.status === 'active').length;
    const totalImpressions = (campaigns || []).reduce((s, c) => s + (c.impressions || 0), 0);
    const adRevenue = (campaigns || []).reduce((s, c) => s + fmt(c.revenue_usd), 0);

    return res.json({ campaigns: campaigns || [], stats: { activeCampaigns: active, totalImpressions, adRevenue } });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/ads/upload-image ──────────────────────────────────

export async function uploadAdImage(req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: 'Image file is required.' });
    if (!isConfigured() || !supabase) {
      return res.status(503).json({ message: 'Storage not configured.' });
    }

    const bucket = process.env.SUPABASE_IMAGE_BUCKET || 'images';
    const ext = (req.file.originalname || 'ad.jpg').split('.').pop()?.toLowerCase() || 'jpg';
    const filename = `ads/${randomUUID()}.${ext}`;

    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (error) return res.status(500).json({ message: error.message });

    const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const imageUrl = `${baseUrl}/storage/v1/object/public/${bucket}/${data.path}`;

    // Detect image dimensions if sharp is available; otherwise fall back to 0
    let width = 0;
    let height = 0;
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(req.file.buffer).metadata();
      width  = meta.width  || 0;
      height = meta.height || 0;
    } catch (_) {}

    return res.status(201).json({ url: imageUrl, width, height });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/ads ───────────────────────────────────────────────

const VALID_PLACEMENTS = [
  'homepage_banner',
  'homepage_top',
  'homepage_bottom',
  'sidebar',
  'feed',
  'feed_native',
  'homepage_feed',
  'in_feed',
  'feed_side_widget',
  'mobile_inline',
  'category_feed',
  'video_page',
  'sticky_banner',
  'native_card',
  'before_footer',
];
const VALID_AD_SIZES = ['160x600', '300x100', '300x250', '305x99', '315x300', '728x90', '900x250'];
const VALID_DEVICE_TARGETS = ['all', 'desktop', 'tablet', 'mobile'];

const AD_CAMPAIGN_LEGACY_PLACEMENT = {
  homepage_top: 'homepage_banner',
  homepage_bottom: 'homepage_banner',
  sticky_banner: 'homepage_banner',
  before_footer: 'homepage_banner',
  feed_native: 'feed',
  homepage_feed: 'feed',
  in_feed: 'feed',
  feed_side_widget: 'feed',
  mobile_inline: 'feed',
  category_feed: 'feed',
  native_card: 'feed',
  video_page: 'video_player',
};

function isAdPlacementConstraintError(error) {
  return error?.code === '23514' && /ad_campaigns_placement_check|placement/i.test(String(error.message || error.details || ''));
}

function withLegacyAdPlacement(payload) {
  const placement = AD_CAMPAIGN_LEGACY_PLACEMENT[payload.placement] || payload.placement;
  if (placement === payload.placement && !payload.placement_type) return null;
  const next = { ...payload, placement };
  delete next.placement_type;
  return next;
}

function noteOmittedColumn(omittedColumns, column) {
  if (column && !omittedColumns.includes(column)) omittedColumns.push(column);
}

async function runAdCampaignWriteWithSchemaFallback(run, payload) {
  let current = { ...payload };
  let attemptedReload = false;
  const omittedColumns = [];
  const maxAttempts = Object.keys(current).length + 4;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await run(current);
    if (!result.error) return { ...result, omittedColumns };

    let missingColumn = missingAdsColumnName(result.error);
    if (missingColumn && Object.prototype.hasOwnProperty.call(current, missingColumn)) {
      if (!attemptedReload) {
        attemptedReload = true;
        await tryNotifyPgrstReloadSchema(supabase);
        const retry = await run(current);
        if (!retry.error) return { ...retry, omittedColumns };
        missingColumn = missingAdsColumnName(retry.error);
        if (!missingColumn || !Object.prototype.hasOwnProperty.call(current, missingColumn)) {
          return { ...retry, omittedColumns };
        }
      }
      delete current[missingColumn];
      noteOmittedColumn(omittedColumns, missingColumn);
      continue;
    }

    if (isAdPlacementConstraintError(result.error)) {
      const legacy = withLegacyAdPlacement(current);
      if (legacy) {
        current = legacy;
        noteOmittedColumn(omittedColumns, 'placement_type');
        continue;
      }
    }

    return { ...result, omittedColumns };
  }

  return {
    data: null,
    error: new Error('Ad campaign schema fallback exceeded retry limit.'),
    omittedColumns,
  };
}

export async function createAdCampaign(req, res) {
  try {
    const {
      name, description, budget_usd, cpc,
      start_date, end_date,
      image_url, redirect_url, cta_text, placement,
      image_width, image_height,
      status: requestedStatus,
      source_type, external_platform, network_visible,
      embed_html, embed_sanitized_html,
      slot_key, placement_type, ad_size, device_target, priority, metadata,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ message: 'Campaign name is required.' });
    if (redirect_url && !/^https?:\/\/.+/i.test(redirect_url.trim())) {
      return res.status(400).json({ message: 'Redirect URL must be a valid http(s) URL.' });
    }
    const resolvedPlacement = VALID_PLACEMENTS.includes(placement) ? placement : 'homepage_banner';
    const allowedStatuses = new Set(['active', 'paused', 'ended', 'pending']);
    const initialStatus = allowedStatuses.has(requestedStatus) ? requestedStatus : 'active';

    const payload = {
      id:           randomUUID(),
      name:         name.trim(),
      description:  description?.trim() || null,
      budget_usd:   parseFloat(budget_usd) || 0,
      cpc:          parseFloat(cpc) || 0,
      impressions:  0,
      clicks:       0,
      revenue_usd:  0,
      status:       initialStatus,
      is_active:    initialStatus === 'active',
      start_date:   start_date || null,
      end_date:     end_date   || null,
      image_url:    image_url  || null,
      redirect_url: redirect_url?.trim() || null,
      cta_text:     cta_text?.trim()     || 'Learn More',
      placement:    resolvedPlacement,
      slot_key:     slot_key?.trim() || null,
      placement_type: VALID_PLACEMENTS.includes(placement_type) ? placement_type : resolvedPlacement,
      ad_size:      VALID_AD_SIZES.includes(ad_size) ? ad_size : null,
      device_target: VALID_DEVICE_TARGETS.includes(device_target) ? device_target : 'all',
      priority:     Number.isFinite(Number(priority)) ? Number(priority) : 100,
      metadata:     metadata && typeof metadata === 'object' ? metadata : {},
      image_width:  parseInt(image_width)  || null,
      image_height: parseInt(image_height) || null,
      source_type:  ['image', 'external_link', 'embed'].includes(source_type) ? source_type : 'image',
      external_platform: external_platform?.trim() || null,
      network_visible: Boolean(network_visible),
      ownership: 'platform',
      payment_status: initialStatus === 'active' ? 'waived' : 'pending',
      embed_html: embed_html || null,
      embed_sanitized_html: embed_sanitized_html || embed_html || null,
      creative_type: source_type === 'embed' ? 'embed' : 'image',
      created_by:   req.admin?.id || null,
    };

    const { data, error, omittedColumns = [] } = await runAdCampaignWriteWithSchemaFallback(
      (row) => supabase.from('ad_campaigns').insert(row).select().single(),
      payload,
    );

    if (isAdsTableMissing(error)) {
      return res.status(503).json(adsSchemaMissingPayload());
    }
    if (error) return res.status(500).json({ message: error.message });
    return res.status(201).json({ campaign: data, omittedColumns });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/finance/ads/:id ────────────────────────────────────────────

export async function updateAdCampaign(req, res) {
  try {
    const { id } = req.params;
    const {
      name, description, budget_usd, cpc,
      status, is_active, start_date, end_date,
      image_url, redirect_url, cta_text, placement,
      image_width, image_height,
      slot_key, placement_type, ad_size, device_target, priority, metadata,
    } = req.body;

    if (redirect_url !== undefined && redirect_url && !/^https?:\/\/.+/i.test(redirect_url.trim())) {
      return res.status(400).json({ message: 'Redirect URL must be a valid http(s) URL.' });
    }

    const updates = {};
    if (name         !== undefined) updates.name         = String(name).trim();
    if (description  !== undefined) updates.description  = description;
    if (budget_usd   !== undefined) updates.budget_usd   = parseFloat(budget_usd);
    if (cpc          !== undefined) updates.cpc          = parseFloat(cpc);
    if (status       !== undefined) {
      updates.status    = status;
      updates.is_active = (status === 'active');
    }
    if (is_active    !== undefined) {
      updates.is_active = Boolean(is_active);
      if (!updates.status) updates.status = is_active ? 'active' : 'paused';
    }
    if (start_date   !== undefined) updates.start_date   = start_date   || null;
    if (end_date     !== undefined) updates.end_date     = end_date     || null;
    if (image_url    !== undefined) updates.image_url    = image_url    || null;
    if (redirect_url !== undefined) updates.redirect_url = redirect_url?.trim() || null;
    if (cta_text     !== undefined) updates.cta_text     = cta_text?.trim() || 'Learn More';
    if (placement    !== undefined && VALID_PLACEMENTS.includes(placement)) updates.placement = placement;
    if (slot_key     !== undefined) updates.slot_key = slot_key?.trim() || null;
    if (placement_type !== undefined && VALID_PLACEMENTS.includes(placement_type)) updates.placement_type = placement_type;
    if (ad_size      !== undefined && VALID_AD_SIZES.includes(ad_size)) updates.ad_size = ad_size;
    if (device_target !== undefined && VALID_DEVICE_TARGETS.includes(device_target)) updates.device_target = device_target;
    if (priority     !== undefined && Number.isFinite(Number(priority))) updates.priority = Number(priority);
    if (metadata     !== undefined && metadata && typeof metadata === 'object') updates.metadata = metadata;
    if (image_width  !== undefined) updates.image_width  = parseInt(image_width)  || null;
    if (image_height !== undefined) updates.image_height = parseInt(image_height) || null;

    const { data, error } = await runAdCampaignWriteWithSchemaFallback(
      (row) => {
        if (!Object.keys(row).length) {
          return supabase.from('ad_campaigns').select('*').eq('id', id).maybeSingle();
        }
        return supabase
          .from('ad_campaigns')
          .update(row)
          .eq('id', id)
          .select()
          .single();
      },
      updates,
    );

    if (isAdsTableMissing(error)) return res.status(503).json(adsSchemaMissingPayload());
    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: 'Campaign not found.' });
    return res.json({ campaign: data });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── DELETE /api/admin/finance/ads/:id ────────────────────────────────────────

export async function deleteAdCampaign(req, res) {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('ad_campaigns').delete().eq('id', id);
    if (isAdsTableMissing(error)) return res.status(503).json(adsSchemaMissingPayload());
    if (error) return res.status(500).json({ message: error.message });
    return res.json({ message: 'Campaign deleted.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getFraudAlertsAdmin(req, res) {
  try {
    const data = await getFraudAlerts(req.query);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getWebhookEventsAdmin(req, res) {
  try {
    const data = await getWebhookEvents(req.query);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getPaymentAuditAdmin(req, res) {
  try {
    const data = await getPaymentAuditTrail(req.params.id);
    return res.json(data);
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 500;
    return res.status(status).json({ message: err.message });
  }
}

export async function getPaymentReconciliationAdmin(req, res) {
  try {
    const hours = Number(req.query.hours) || 24;
    const data = await getPaymentReconciliationReport({ hours });
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getGatewayAnalyticsAdmin(req, res) {
  try {
    const hours = Number(req.query.hours) || 24;
    const [analytics, health] = await Promise.all([
      getGatewayAnalytics({ hours }),
      getGatewayHealth(),
    ]);
    return res.json({ analytics, health });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}
