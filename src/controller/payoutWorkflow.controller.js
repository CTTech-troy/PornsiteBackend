import { getRawRequestBody } from '../middleware/qstashSignature.js';
import {
  assignApprovedPayoutToFinance,
  generatePayoutDailySummary,
  runDuePayoutVerification,
  runPayoutNotification,
} from '../services/payoutWorkflow.service.js';
import { supabase } from '../config/supabase.js';

function readPayload(req) {
  const raw = getRawRequestBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function workflowMeta(req, type) {
  return {
    type,
    messageId: req.get('Upstash-Message-Id') || null,
    retried: Number(req.get('Upstash-Retried') || 0),
    timestamp: new Date().toISOString(),
  };
}

export async function notifyPayoutWorkflow(req, res) {
  const payload = readPayload(req);
  try {
    const result = await runPayoutNotification({
      type: payload.type?.replace(/^payout_/, '') || payload.payload?.type || 'processing',
      payoutId: payload.payoutId,
      payload: payload.payload || {},
    });
    return res.json({ success: true, workflow: workflowMeta(req, 'payout.notify'), result });
  } catch (error) {
    console.error('[payout:qstash] notification failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'payout.notify'), message: error?.message || 'Notification failed.' });
  }
}

export async function assignFinanceWorkflow(req, res) {
  const payload = readPayload(req);
  try {
    const result = await assignApprovedPayoutToFinance({
      id: payload.payoutId,
      financeAssigneeId: payload.financeAssigneeId || null,
      io: req.app?.get('io'),
    });
    return res.json({ success: true, workflow: workflowMeta(req, 'payout.assign_finance'), payout: result });
  } catch (error) {
    console.error('[payout:qstash] finance assignment failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'payout.assign_finance'), message: error?.message || 'Finance assignment failed.' });
  }
}

export async function verifyPayoutWorkflow(req, res) {
  const payload = readPayload(req);
  try {
    if (payload.payoutId && supabase) {
      await supabase.from('payout_audit_logs').insert({
        payout_request_id: payload.payoutId,
        actor_type: 'qstash',
        action: 'payout_verification_queued',
        metadata: payload,
      });
    }
    return res.json({ success: true, workflow: workflowMeta(req, 'payout.verify'), verified: Boolean(payload.payoutId) });
  } catch (error) {
    console.error('[payout:qstash] verify failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'payout.verify'), message: error?.message || 'Verification failed.' });
  }
}

export async function verifyDuePayoutsWorkflow(req, res) {
  try {
    const result = await runDuePayoutVerification({ io: req.app?.get('io') });
    return res.json({ success: true, workflow: workflowMeta(req, 'payout.verify_due'), result });
  } catch (error) {
    console.error('[payout:qstash] verify due failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'payout.verify_due'), message: error?.message || 'Due verification failed.' });
  }
}

export async function payoutAuditWorkflow(req, res) {
  const payload = readPayload(req);
  try {
    if (supabase) {
      await supabase.from('payout_audit_logs').insert({
        payout_request_id: payload.payoutId || null,
        actor_type: 'qstash',
        action: payload.type || 'payout_audit_event',
        notes: payload.notes || null,
        metadata: payload,
      });
    }
    return res.json({ success: true, workflow: workflowMeta(req, 'payout.audit') });
  } catch (error) {
    console.error('[payout:qstash] audit failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'payout.audit'), message: error?.message || 'Audit failed.' });
  }
}

export async function payoutDailySummaryWorkflow(req, res) {
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await generatePayoutDailySummary(yesterday);
    return res.json({ success: true, workflow: workflowMeta(req, 'payout.daily_summary'), result });
  } catch (error) {
    console.error('[payout:qstash] daily summary failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'payout.daily_summary'), message: error?.message || 'Summary failed.' });
  }
}

export async function payoutWorkflowFailure(req, res) {
  const payload = readPayload(req);
  console.error('[payout:qstash] workflow delivery failed', {
    messageId: req.get('Upstash-Message-Id') || null,
    retried: req.get('Upstash-Retried') || null,
    payload,
  });
  return res.json({ success: true, workflow: workflowMeta(req, 'payout.failure'), received: true });
}
