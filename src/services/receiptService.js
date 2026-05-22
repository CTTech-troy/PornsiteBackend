import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { randomUUID } from 'crypto';
import PDFDocument from 'pdfkit';
import { supabase } from '../config/supabase.js';
import { getCreatorPayoutBalances } from './payoutWorkflow.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, '../templates');

function isMissingDbFeature(error) {
  const message = String(error?.message || '');
  return (
    error?.code === '42P01' ||
    error?.code === '42703' ||
    error?.code === 'PGRST200' ||
    /schema cache|does not exist/i.test(message)
  );
}

function escHtml(value) {
  return String(value ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function fmtUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function fmtDateTime(value) {
  if (!value) return new Date().toLocaleString('en-US', { timeZone: process.env.FINANCE_TZ || 'America/Lagos' });
  return new Date(value).toLocaleString('en-US', {
    timeZone: process.env.FINANCE_TZ || 'America/Lagos',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

async function loadTemplate(name) {
  return readFile(path.join(TEMPLATE_DIR, name), 'utf8');
}

function applyTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (html, [key, value]) => html.replaceAll(`{{${key}}}`, escHtml(value)),
    template,
  );
}

export async function generateReceiptNumber() {
  const year = new Date().getFullYear();
  const { count, error } = await supabase
    .from('payout_receipts')
    .select('*', { count: 'exact', head: true });
  if (error && !isMissingDbFeature(error)) throw error;
  const seq = (count || 0) + 1;
  return `XR-${year}-${String(seq).padStart(6, '0')}`;
}

export function buildReceiptMetadata(payout, type, balances = {}) {
  const txnId = payout.transaction_reference
    || payout.paystack_transaction_reference
    || payout.reference_id
    || `PAY-${String(payout.id || '').slice(0, 8).toUpperCase()}`;

  return {
    type,
    creatorId: payout.creator_id,
    creatorName: payout.creator_name || payout.account_name || 'Creator',
    creatorEmail: payout.creator_email,
    amountUsd: Number(payout.amount_usd || 0),
    amountNgn: payout.amount_ngn == null ? null : Number(payout.amount_ngn),
    remainingBalance: balances.available ?? payout.remaining_balance_after ?? null,
    walletBalanceBefore: payout.wallet_balance_before ?? balances.total ?? null,
    walletBalanceAfter: payout.wallet_balance_after ?? balances.available ?? null,
    paymentMethod: payout.bank_name || payout.method || 'Bank transfer',
    transactionId: txnId,
    referenceId: payout.reference_id,
    reason: payout.rejection_reason || payout.failure_reason || null,
    paidAt: payout.paid_at || payout.completed_at || new Date().toISOString(),
    rejectedAt: payout.processed_at || new Date().toISOString(),
    ceoName: process.env.CEO_NAME || 'XstreamVideos Finance',
    supportEmail: process.env.SUPPORT_EMAIL || 'support@xstreamvideos.site',
    logoUrl: process.env.COMPANY_LOGO_URL || 'https://xstreamvideos.site/logo.png',
  };
}

export async function renderReceiptHtml(type, metadata, receiptNumber) {
  const templateName = type === 'paid' ? 'payoutReceiptPaid.html' : 'payoutReceiptRejected.html';
  const template = await loadTemplate(templateName);
  const vars = {
    receiptNumber,
    logoUrl: metadata.logoUrl,
    creatorName: metadata.creatorName,
    creatorId: metadata.creatorId,
    amountUsd: fmtUsd(metadata.amountUsd),
    remainingBalance: metadata.remainingBalance == null ? '—' : fmtUsd(metadata.remainingBalance),
    paymentMethod: metadata.paymentMethod,
    transactionId: metadata.transactionId,
    paidAt: fmtDateTime(metadata.paidAt),
    rejectedAt: fmtDateTime(metadata.rejectedAt),
    reason: metadata.reason || 'No reason provided.',
    ceoName: metadata.ceoName,
    supportEmail: metadata.supportEmail,
  };
  return applyTemplate(template, vars);
}

export function generateReceiptPdfBuffer(metadata, receiptNumber) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text('XstreamVideos', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(14).fillColor(metadata.type === 'paid' ? '#059669' : '#DC2626')
      .text(metadata.type === 'paid' ? 'PAID' : 'REJECTED', { align: 'right' });
    doc.fillColor('#000000');
    doc.moveDown();
    doc.fontSize(16).text(metadata.type === 'paid' ? 'Withdrawal Receipt' : 'Withdrawal Declined');
    doc.fontSize(10).fillColor('#666666').text(`Receipt ${receiptNumber}`);
    doc.fillColor('#000000').moveDown();

    doc.fontSize(11);
    doc.text(`Creator: ${metadata.creatorName}`);
    doc.text(`Creator ID: ${metadata.creatorId}`);
    doc.text(`Amount: ${fmtUsd(metadata.amountUsd)}`);
    if (metadata.remainingBalance != null) doc.text(`Remaining balance: ${fmtUsd(metadata.remainingBalance)}`);
    doc.text(`Payment method: ${metadata.paymentMethod}`);
    doc.text(`Transaction ID: ${metadata.transactionId}`);
    if (metadata.type === 'rejected' && metadata.reason) {
      doc.moveDown().text(`Reason: ${metadata.reason}`);
    }
    doc.moveDown(2);
    doc.fontSize(10).fillColor('#666666').text(`Authorized by ${metadata.ceoName}`);
    doc.text(metadata.supportEmail);

    doc.end();
  });
}

async function insertWalletLedger({ creatorId, deltaUsd, balanceAfter, source, referenceId, metadata = {} }) {
  const row = {
    creator_id: creatorId,
    delta_usd: deltaUsd,
    balance_after: balanceAfter,
    source,
    reference_id: referenceId,
    metadata,
  };
  const { error } = await supabase.from('creator_wallet_ledger').insert(row);
  if (error && !isMissingDbFeature(error)) console.warn('[receipt] ledger insert failed:', error.message);
}

export async function createPayoutReceipt(payout, type, { adminId = null } = {}) {
  if (!supabase || !payout?.id) return null;

  let balances = {};
  try {
    balances = await getCreatorPayoutBalances(payout.creator_id);
  } catch {}

  const receiptNumber = await generateReceiptNumber();
  const metadata = buildReceiptMetadata(payout, type, balances);
  const htmlBody = await renderReceiptHtml(type, metadata, receiptNumber);

  const ledgerSource = type === 'paid' ? 'withdrawal_paid' : 'withdrawal_release';
  await insertWalletLedger({
    creatorId: payout.creator_id,
    deltaUsd: type === 'paid' ? -Number(payout.amount_usd || 0) : Number(payout.amount_usd || 0),
    balanceAfter: balances.available ?? metadata.remainingBalance ?? 0,
    source: ledgerSource,
    referenceId: payout.id,
    metadata: { receiptNumber, type },
  });

  const payoutUpdate = {
    receipt_number: receiptNumber,
    wallet_balance_before: metadata.walletBalanceBefore,
    wallet_balance_after: metadata.walletBalanceAfter,
    remaining_balance_after: metadata.remainingBalance,
    updated_at: new Date().toISOString(),
  };
  if (type === 'paid' && adminId) payoutUpdate.paid_by_admin_id = adminId;
  if (type === 'rejected' && adminId) payoutUpdate.rejected_by_admin_id = adminId;

  await supabase.from('creator_payout_requests').update(payoutUpdate).eq('id', payout.id);

  const { data: receipt, error } = await supabase
    .from('payout_receipts')
    .insert({
      payout_request_id: payout.id,
      type,
      receipt_number: receiptNumber,
      html_body: htmlBody,
      metadata,
    })
    .select()
    .single();

  if (error) {
    if (!isMissingDbFeature(error)) throw error;
    return { receiptNumber, htmlBody, metadata, id: null };
  }

  return { ...receipt, receiptNumber, htmlBody, metadata };
}

export async function getReceiptForPayout(payoutId, type = null) {
  let query = supabase
    .from('payout_receipts')
    .select('*')
    .eq('payout_request_id', payoutId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (type) query = query.eq('type', type);
  const { data, error } = await query.maybeSingle();
  if (error && !isMissingDbFeature(error)) throw error;
  return data;
}

export async function streamReceiptPdf(res, receipt, metadata) {
  const meta = metadata || receipt?.metadata || {};
  const buffer = generateReceiptPdfBuffer(
    { ...meta, type: receipt?.type || meta.type },
    receipt?.receipt_number || meta.receiptNumber,
  );
  const pdfBuffer = await buffer;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${receipt?.receipt_number || 'payout'}.pdf"`);
  res.send(pdfBuffer);
}

export async function queueReceiptEmail({ to, subject, htmlBody, payload = {} }) {
  if (!supabase) return null;
  const row = {
    id: randomUUID(),
    to_email: to,
    subject,
    html_body: htmlBody,
    payload,
    status: 'pending',
  };
  const { data, error } = await supabase.from('finance_email_queue').insert(row).select().maybeSingle();
  if (error && !isMissingDbFeature(error)) console.warn('[receipt] email queue failed:', error.message);
  return data;
}
