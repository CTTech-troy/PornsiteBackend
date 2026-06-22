import { Resend } from 'resend';
import { getEmailTheme, isValidEmail } from './emailRenderer.js';
import {
  renderEmailTemplate,
  renderNotificationEmail,
  templateKeyForApplicationStatus,
} from './emailTemplates.js';
import {
  getActiveTemplateOverride,
  normalizeTemplateOverrides,
} from './emailTemplateAdmin.service.js';

let resendClient = null;

export function getResend() {
  if (!resendClient && process.env.RESEND_API_KEY) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

export function getFrom() {
  return process.env.RESEND_FROM_EMAIL || 'XstreamVideos <support@xstreamvideos.site>';
}

function validateFrom(from = getFrom()) {
  const email = from.includes('<') ? from.match(/<([^>]+)>/)?.[1] : from;
  if (!email || !isValidEmail(email)) {
    throw new Error(`RESEND_FROM_EMAIL is misconfigured: "${from}" must contain a valid email address.`);
  }
  return from;
}

function requireResend() {
  const resend = getResend();
  if (!resend) {
    throw new Error('Email service not configured - set RESEND_API_KEY in environment.');
  }
  return resend;
}

async function resolveTemplateOverrides(templateKey, overrides = {}) {
  let saved = {};
  try {
    const active = await getActiveTemplateOverride(templateKey);
    saved = active?.overrides || {};
  } catch (err) {
    console.warn(`[email] template override lookup skipped for ${templateKey}: ${err.message}`);
  }
  return {
    ...normalizeTemplateOverrides(saved),
    ...normalizeTemplateOverrides(overrides),
  };
}

export async function renderTemplateEmail(templateKey, variables = {}, overrides = {}) {
  const mergedOverrides = await resolveTemplateOverrides(templateKey, overrides);
  return renderEmailTemplate(templateKey, variables, { overrides: mergedOverrides });
}

async function sendTemplateEmail({
  to,
  templateKey,
  variables = {},
  overrides = {},
  required = true,
  logLabel = templateKey,
}) {
  if (!to || !isValidEmail(to)) {
    if (required) throw new Error(`Invalid email recipient: ${to || '(empty)'}`);
    return null;
  }

  const resend = getResend();
  if (!resend) {
    if (required) throw new Error('Email service not configured - set RESEND_API_KEY in environment.');
    console.warn(`[email] ${logLabel} skipped: RESEND_API_KEY is missing.`);
    return null;
  }

  const from = validateFrom();
  const theme = getEmailTheme();
  const rendered = await renderTemplateEmail(templateKey, variables, overrides);
  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: theme.supportEmail,
    tags: [
      { name: 'template', value: templateKey },
      { name: 'category', value: rendered.meta?.category || 'Email' },
    ],
  });

  if (error) {
    if (required) throw new Error(`Resend error: ${error.message}`);
    console.error(`[email] ${logLabel} failed for ${to}: ${error.message}`);
    return { error: error.message };
  }

  console.log(`[email] ${logLabel} sent to ${to} (id: ${data?.id || 'n/a'})`);
  return { id: data?.id || null, subject: rendered.subject };
}

export async function sendEmailTemplateTest({ to, templateKey, variables = {}, overrides = {} }) {
  return sendTemplateEmail({
    to,
    templateKey,
    variables,
    overrides,
    required: true,
    logLabel: `email template test ${templateKey}`,
  });
}

export async function sendVerificationEmail({ to, name, verificationUrl }) {
  return sendTemplateEmail({
    to,
    templateKey: 'email_verification',
    variables: { name, verificationUrl },
    logLabel: 'verification',
  });
}

export async function sendWelcomeEmail({ to, name, dashboardUrl }) {
  return sendTemplateEmail({
    to,
    templateKey: 'welcome',
    variables: { name, dashboardUrl },
    required: false,
    logLabel: 'welcome',
  });
}

export async function sendPasswordResetEmail({ to, name, resetUrl }) {
  return sendTemplateEmail({
    to,
    templateKey: 'password_reset',
    variables: { name, resetUrl },
    logLabel: 'password reset',
  });
}

export async function sendLoginAlertEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'login_alert',
    variables: payload,
    required: false,
    logLabel: 'login alert',
  });
}

export async function sendAccountRecoveryEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'account_recovery',
    variables: payload,
    required: false,
    logLabel: 'account recovery',
  });
}

export async function sendAdminInviteEmail({ to, name, inviteUrl, permissions }) {
  return sendTemplateEmail({
    to,
    templateKey: 'admin_invite',
    variables: { name, inviteUrl, permissions },
    logLabel: 'admin invite',
  });
}

export async function sendUserNotificationEmail(templateKey, payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey,
    variables: payload,
    required: false,
    logLabel: `user notification ${templateKey}`,
  });
}

export async function sendApplicationDecisionEmail({
  to,
  name,
  status,
  reason,
  missingFields = [],
  updateLink = null,
}) {
  return sendTemplateEmail({
    to,
    templateKey: templateKeyForApplicationStatus(status),
    variables: { name, reason, missingFields, updateLink },
    required: false,
    logLabel: `creator application ${status || 'update'}`,
  });
}

export async function sendContentApprovedEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'content_approved',
    variables: payload,
    required: false,
    logLabel: 'content approved',
  });
}

export async function sendContentRejectedEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'content_rejected',
    variables: payload,
    required: false,
    logLabel: 'content rejected',
  });
}

export async function sendAccountDeletionEmail({
  to,
  name,
  reason,
  platformUrl = 'https://xstreamvideos.site',
}) {
  return sendTemplateEmail({
    to,
    templateKey: 'account_deletion',
    variables: { name, reason, platformUrl },
    logLabel: 'account deletion',
  });
}

export async function sendPurchaseConfirmationEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'purchase_confirmation',
    variables: payload,
    required: false,
    logLabel: 'purchase confirmation',
  });
}

export async function sendSubscriptionConfirmationEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'subscription_confirmation',
    variables: payload,
    required: false,
    logLabel: 'subscription confirmation',
  });
}

export async function sendSubscriptionRenewalEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'subscription_renewal',
    variables: payload,
    required: false,
    logLabel: 'subscription renewal',
  });
}

export async function sendFailedPaymentEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'failed_payment',
    variables: payload,
    required: false,
    logLabel: 'failed payment',
  });
}

export async function sendRefundNotificationEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'refund_notification',
    variables: payload,
    required: false,
    logLabel: 'refund notification',
  });
}

export async function sendContentRemovalConfirmationEmail({ to, name, requestId, contentUrl, deadlineAt }) {
  return sendTemplateEmail({
    to,
    templateKey: 'content_removal_confirmation',
    variables: { name, requestId, contentUrl, deadlineAt },
    required: false,
    logLabel: 'content removal confirmation',
  });
}

export async function sendContentRemovalStatusEmail({
  to,
  name,
  requestId,
  status,
  statusLabel,
  message,
  deadlineAt,
}) {
  return sendTemplateEmail({
    to,
    templateKey: 'content_removal_status',
    variables: { name, requestId, status, statusLabel, message, deadlineAt },
    required: false,
    logLabel: 'content removal status',
  });
}

export async function sendContentRemovalFeedbackEmail({ to, name, requestId, message }) {
  return sendTemplateEmail({
    to,
    templateKey: 'content_removal_feedback',
    variables: { name, requestId, message },
    logLabel: 'content removal feedback',
  });
}

export async function sendAdminNotificationEmail(templateKey, payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey,
    variables: payload,
    required: false,
    logLabel: `admin notification ${templateKey}`,
  });
}

export async function sendAdminNewCreatorApplicationEmail(payload) {
  return sendAdminNotificationEmail('admin_new_creator_application', payload);
}

export async function sendAdminNewReportEmail(payload) {
  return sendAdminNotificationEmail('admin_new_report', payload);
}

export async function sendAdminFinancialAlertEmail(payload) {
  return sendAdminNotificationEmail('admin_financial_alert', payload);
}

export async function sendAdminSystemAlertEmail(payload) {
  return sendAdminNotificationEmail('admin_system_alert', payload);
}

export async function sendPayoutRequestedEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'withdrawal_requested',
    variables: payload,
    required: false,
    logLabel: 'payout requested',
  });
}

export async function sendPayoutApprovedEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'withdrawal_approved',
    variables: payload,
    required: false,
    logLabel: 'payout approved',
  });
}

export async function sendPayoutPaidEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'withdrawal_paid',
    variables: payload,
    required: false,
    logLabel: 'payout paid',
  });
}

export async function sendPayoutRejectedEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'withdrawal_rejected',
    variables: payload,
    required: false,
    logLabel: 'payout rejected',
  });
}

export async function sendPaymentSuccessEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'payment_success',
    variables: payload,
    required: false,
    logLabel: 'payment success',
  });
}

export async function sendPaymentFailureEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'payment_failure',
    variables: payload,
    required: false,
    logLabel: 'payment failure',
  });
}

export async function sendPremiumPurchaseReceiptEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'premium_purchase_receipt',
    variables: payload,
    required: false,
    logLabel: 'premium purchase receipt',
  });
}

export async function sendGiftNotificationEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'gift_notification',
    variables: payload,
    required: false,
    logLabel: 'gift notification',
  });
}

export async function sendLiveSessionNotificationEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'live_session_notification',
    variables: payload,
    required: false,
    logLabel: 'live session notification',
  });
}

export async function sendPartnerVerificationEmail(payload) {
  return sendTemplateEmail({
    to: payload?.to,
    templateKey: 'partner_verification',
    variables: payload,
    required: false,
    logLabel: 'partner verification',
  });
}

export async function sendOTPEmail(to, otp) {
  return sendTemplateEmail({
    to,
    templateKey: 'otp',
    variables: { otp },
    logLabel: 'otp',
  });
}

export async function sendAdminEmail(to, subject, message) {
  if (!to || !isValidEmail(to)) throw new Error(`Invalid email recipient: ${to || '(empty)'}`);
  const resend = requireResend();
  const from = validateFrom();
  const theme = getEmailTheme();
  const rendered = renderNotificationEmail({
    subject,
    heading: subject || 'Message from XstreamVideos',
    message,
    ctaLabel: null,
    ctaUrl: null,
    eyebrow: 'Admin message',
  });
  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: theme.supportEmail,
    tags: [{ name: 'template', value: rendered.key || 'notification' }],
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[email] admin message sent to ${to} (id: ${data?.id || 'n/a'})`);
  return { id: data?.id || null };
}

export async function sendPremiumVideoPurchaseEmails({
  buyerEmail,
  buyerName,
  creatorEmail,
  creatorName,
  videoTitle,
  purchaseAmountUsd,
  creatorEarningsUsd,
  platformEarningsUsd,
  purchasedAt,
  transactionId,
}) {
  const resend = getResend();
  if (!resend) {
    console.warn('[email] premium purchase emails skipped: RESEND_API_KEY is missing.');
    return null;
  }

  const sent = [];
  if (buyerEmail && isValidEmail(buyerEmail)) {
    const buyerResult = await sendTemplateEmail({
      to: buyerEmail,
      templateKey: 'premium_purchase_receipt',
      variables: {
        name: buyerName,
        videoTitle,
        creatorName,
        amountUsd: purchaseAmountUsd,
        transactionId: transactionId || `PREMIUM-${Date.now()}`,
        purchasedAt,
      },
      required: false,
      logLabel: 'premium buyer receipt',
    });
    if (buyerResult) sent.push(buyerResult);
  }

  if (creatorEmail && isValidEmail(creatorEmail)) {
    const creatorResult = await sendTemplateEmail({
      to: creatorEmail,
      templateKey: 'premium_sale_creator',
      variables: {
        creatorName,
        buyerName,
        videoTitle,
        purchaseAmountUsd,
        creatorEarningsUsd,
        platformEarningsUsd,
        purchasedAt,
      },
      required: false,
      logLabel: 'premium creator sale',
    });
    if (creatorResult) sent.push(creatorResult);
  }

  const adminEmail = process.env.ADMIN_FINANCE_EMAIL || process.env.SUPPORT_NOTIFICATIONS_EMAIL;
  if (adminEmail && isValidEmail(adminEmail)) {
    const adminResult = await sendTemplateEmail({
      to: adminEmail,
      templateKey: 'premium_purchase_receipt',
      variables: {
        name: 'Finance team',
        videoTitle,
        creatorName,
        amountUsd: purchaseAmountUsd,
        transactionId: transactionId || `PREMIUM-${Date.now()}`,
        purchasedAt,
      },
      required: false,
      logLabel: 'premium purchase admin receipt',
    });
    if (adminResult) sent.push(adminResult);
  }

  return sent;
}
