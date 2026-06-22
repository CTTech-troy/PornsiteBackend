import {
  escapeHtml,
  formatDateTime,
  formatNgn,
  formatUsd,
  htmlToText,
  renderEmailLayout,
  safeUrl,
} from './emailRenderer.js';

const TEMPLATE_VERSION = '2026.06-enterprise-email-design-system';

const studioUrl = () => `${String(process.env.FRONTEND_URL || 'https://xstreamvideos.site').replace(/\/$/, '')}/studio`;
const homeUrl = () => String(process.env.FRONTEND_URL || 'https://xstreamvideos.site').replace(/\/$/, '');
const adminUrl = () => String(process.env.ADMIN_FRONTEND_URL || 'https://admin.xstreamvideos.site').replace(/\/$/, '');

const REGISTRY = [
  ['welcome', 'Welcome email', 'Authentication', 'Concise welcome email after account creation.'],
  ['email_verification', 'Email verification', 'Authentication', 'Secure account activation with fallback link.'],
  ['password_reset', 'Password reset', 'Authentication', 'Secure password reset email.'],
  ['login_alert', 'Login alert', 'Authentication', 'Security notice for a new account login.'],
  ['account_recovery', 'Account recovery', 'Authentication', 'Recovery instructions for account access issues.'],
  ['otp', 'One-time passcode', 'Authentication', 'OTP identity verification.'],
  ['new_follower', 'New follower', 'User notifications', 'Notification when another user follows a profile.'],
  ['new_comment', 'New comment', 'User notifications', 'Notification when a video receives a comment.'],
  ['new_like', 'New like', 'User notifications', 'Notification when a video receives a like.'],
  ['new_message', 'New message', 'User notifications', 'Notification when a user receives a message.'],
  ['account_update', 'Account update', 'User notifications', 'Important account update notification.'],
  ['admin_invite', 'Admin invite', 'Admin', 'Invite an administrator with scoped permissions.'],
  ['account_deletion', 'Account deletion notice', 'Admin', 'Account removal notice sent by admins.'],
  ['creator_application_submitted', 'Creator application submitted', 'Creators', 'Confirmation after creator signup application.'],
  ['creator_application_approved', 'Creator approved', 'Creators', 'Approval email for creators.'],
  ['creator_application_rejected', 'Creator rejected', 'Creators', 'Rejection email with admin note.'],
  ['creator_application_info_requested', 'Creator info requested', 'Creators', 'Missing information request with secure update link.'],
  ['creator_application_reapplied', 'Creator reapplication received', 'Creators', 'Reapplication confirmation.'],
  ['content_approved', 'Content approved', 'Creators', 'Creator notification when uploaded content is approved.'],
  ['content_rejected', 'Content rejected', 'Creators', 'Creator notification when uploaded content is rejected.'],
  ['withdrawal_requested', 'Withdrawal requested', 'Finance', 'Creator withdrawal request confirmation.'],
  ['withdrawal_approved', 'Withdrawal approved', 'Finance', 'Creator payout approval notice.'],
  ['withdrawal_paid', 'Withdrawal paid', 'Finance', 'Creator payout paid notice.'],
  ['withdrawal_rejected', 'Withdrawal rejected', 'Finance', 'Creator withdrawal rejection notice.'],
  ['withdrawal_receipt_paid', 'Withdrawal paid receipt', 'Receipts', 'Invoice-style receipt for paid creator withdrawals.'],
  ['withdrawal_receipt_rejected', 'Withdrawal rejected receipt', 'Receipts', 'Invoice-style receipt for rejected withdrawals.'],
  ['payment_success', 'Payment success', 'Payments', 'Customer payment success receipt.'],
  ['payment_failure', 'Payment failure', 'Payments', 'Customer payment failure notice.'],
  ['purchase_confirmation', 'Purchase confirmation', 'Payments', 'General purchase confirmation email.'],
  ['subscription_confirmation', 'Subscription confirmation', 'Payments', 'Subscription or membership confirmation email.'],
  ['subscription_renewal', 'Subscription renewal', 'Payments', 'Subscription renewal receipt email.'],
  ['failed_payment', 'Failed payment', 'Payments', 'Payment failure email for billing attempts.'],
  ['refund_notification', 'Refund notification', 'Payments', 'Refund confirmation and access update email.'],
  ['premium_purchase_receipt', 'Premium purchase receipt', 'Premium', 'Receipt for premium video purchases.'],
  ['premium_sale_creator', 'Premium sale creator earning', 'Premium', 'Creator earning notification after a premium sale.'],
  ['gift_notification', 'Gift notification', 'Live', 'Creator gift received notice.'],
  ['live_session_notification', 'Live session notification', 'Live', 'Live session start or reminder notification.'],
  ['partner_verification', 'Partner website verification', 'Partners', 'Publisher/webmaster verification instructions.'],
  ['content_removal_confirmation', 'Content removal confirmation', 'Trust', 'Requester receipt for content removal applications.'],
  ['content_removal_status', 'Content removal status', 'Trust', 'Status update for content removal applications.'],
  ['content_removal_feedback', 'Content removal feedback', 'Trust', 'Admin message for a content removal request.'],
  ['admin_new_creator_application', 'New creator application', 'Admin notifications', 'Admin alert for a new creator application.'],
  ['admin_new_report', 'New report', 'Admin notifications', 'Admin alert for a new trust or abuse report.'],
  ['admin_financial_alert', 'Financial alert', 'Admin notifications', 'Admin alert for payment, payout, or revenue issues.'],
  ['admin_system_alert', 'System alert', 'Admin notifications', 'Admin alert for infrastructure and service issues.'],
  ['notification', 'General notification', 'Notifications', 'Reusable branded notification.'],
].map(([key, label, category, description]) => ({
  key,
  label,
  category,
  description,
  version: TEMPLATE_VERSION,
  editableFields: ['subject', 'preheader', 'eyebrow', 'heading', 'intro', 'bodyMarkdown', 'ctaLabel', 'ctaUrl', 'footerNote'],
}));

const SAMPLE_DATA = {
  welcome: {
    name: 'Korede',
    dashboardUrl: homeUrl(),
  },
  email_verification: {
    name: 'Korede',
    verificationUrl: `${homeUrl()}/auth/confirm-email?t=sample-token`,
  },
  password_reset: {
    name: 'Korede',
    resetUrl: `${homeUrl()}/auth/reset-password?token=sample-token`,
  },
  login_alert: {
    name: 'Korede',
    loginTime: new Date().toISOString(),
    ipAddress: '102.89.23.10',
    device: 'Chrome on Windows',
    location: 'Lagos, Nigeria',
    securityUrl: `${homeUrl()}/account/security`,
  },
  account_recovery: {
    name: 'Korede',
    recoveryUrl: `${homeUrl()}/auth/recover?token=sample-token`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  },
  otp: { otp: '482913' },
  new_follower: {
    name: 'Creator',
    followerName: 'Ayo',
    profileUrl: `${homeUrl()}/creator/ayo`,
  },
  new_comment: {
    name: 'Creator',
    commenterName: 'Maya',
    videoTitle: 'Behind the scenes',
    comment: 'This was excellent. Looking forward to more.',
    videoUrl: `${homeUrl()}/watch/sample-video`,
  },
  new_like: {
    name: 'Creator',
    likerName: 'Member',
    videoTitle: 'Premium video',
    videoUrl: `${homeUrl()}/watch/sample-video`,
  },
  new_message: {
    name: 'Korede',
    senderName: 'Support',
    messagePreview: 'We reviewed your request and sent an update.',
    messagesUrl: `${homeUrl()}/messages`,
  },
  account_update: {
    name: 'Korede',
    updateTitle: 'Your payout method was updated',
    message: 'Your creator payout method was changed. If this was not you, secure your account immediately.',
    actionUrl: `${homeUrl()}/account/security`,
  },
  admin_invite: {
    name: 'Admin',
    inviteUrl: `${homeUrl()}/invite/complete?token=sample-token`,
    permissions: ['Users', 'Creators', 'Payments'],
  },
  account_deletion: {
    name: 'Korede',
    reason: 'The account was removed after an administrative review.',
    platformUrl: homeUrl(),
  },
  creator_application_submitted: { name: 'Creator' },
  creator_application_approved: { name: 'Creator' },
  creator_application_rejected: {
    name: 'Creator',
    reason: '- Government ID image is unreadable\n- Profile link does not match the submitted creator name\n\nPlease resubmit with clearer documents.',
  },
  creator_application_info_requested: {
    name: 'Creator',
    missingFields: [{ label: 'Government ID' }, { label: 'Creator bio' }, { label: 'Social profile link' }],
    updateLink: `${homeUrl()}/creator/form?token=sample-token`,
    reason: 'Please upload a clearer ID image and add your official profile link.',
  },
  creator_application_reapplied: { name: 'Creator' },
  content_approved: {
    creatorName: 'Creator',
    videoTitle: 'New premium upload',
    contentUrl: `${homeUrl()}/watch/sample-video`,
    reviewedAt: new Date().toISOString(),
  },
  content_rejected: {
    creatorName: 'Creator',
    videoTitle: 'New premium upload',
    reason: 'The thumbnail does not meet platform policy. Please replace it and resubmit.',
    editUrl: `${studioUrl()}/videos/sample-video/edit`,
    reviewedAt: new Date().toISOString(),
  },
  withdrawal_requested: {
    name: 'Creator',
    amountUsd: 250,
    amountNgn: 375000,
    bankName: 'GTBank',
    accountNumber: '0123456789',
    accountName: 'Creator Account',
    referenceId: 'WDL-10045',
  },
  withdrawal_approved: {
    name: 'Creator',
    amountUsd: 250,
    amountNgn: 375000,
    bankName: 'GTBank',
    accountNumber: '0123456789',
    accountName: 'Creator Account',
    referenceId: 'WDL-10045',
  },
  withdrawal_paid: {
    name: 'Creator',
    amountUsd: 250,
    amountNgn: 375000,
    bankName: 'GTBank',
    accountNumber: '0123456789',
    accountName: 'Creator Account',
    referenceId: 'TRX-778899',
  },
  withdrawal_rejected: {
    name: 'Creator',
    amountUsd: 250,
    reason: 'The destination account details could not be validated.',
  },
  withdrawal_receipt_paid: {
    receiptNumber: 'XR-2026-000018',
    creatorName: 'Creator',
    creatorId: 'usr_12345',
    amountUsd: 250,
    remainingBalance: 1050,
    paymentMethod: 'Bank transfer',
    transactionId: 'TRX-778899',
    paidAt: new Date().toISOString(),
    ceoName: 'XstreamVideos Finance',
  },
  withdrawal_receipt_rejected: {
    receiptNumber: 'XR-2026-000019',
    creatorName: 'Creator',
    creatorId: 'usr_12345',
    amountUsd: 250,
    remainingBalance: 1300,
    paymentMethod: 'Bank transfer',
    transactionId: 'WDL-10045',
    rejectedAt: new Date().toISOString(),
    reason: 'The destination account details could not be validated.',
    ceoName: 'XstreamVideos Finance',
  },
  payment_success: {
    name: 'Member',
    productName: '300 Coins',
    amountUsd: 7.99,
    transactionId: 'PAY-2026-0042',
    paidAt: new Date().toISOString(),
    provider: 'Flutterwave',
    walletBalance: 1200,
  },
  payment_failure: {
    name: 'Member',
    productName: '300 Coins',
    amountUsd: 7.99,
    transactionId: 'PAY-2026-0043',
    failedAt: new Date().toISOString(),
    reason: 'The payment provider declined the transaction.',
  },
  purchase_confirmation: {
    name: 'Member',
    itemName: '300 Coins',
    amountUsd: 7.99,
    transactionId: 'PAY-2026-0042',
    purchasedAt: new Date().toISOString(),
    receiptUrl: `${homeUrl()}/wallet`,
  },
  subscription_confirmation: {
    name: 'Member',
    planName: 'Creator Supporter',
    amountUsd: 14.99,
    renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    manageUrl: `${homeUrl()}/wallet`,
  },
  subscription_renewal: {
    name: 'Member',
    planName: 'Creator Supporter',
    amountUsd: 14.99,
    renewedAt: new Date().toISOString(),
    nextRenewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    manageUrl: `${homeUrl()}/wallet`,
  },
  failed_payment: {
    name: 'Member',
    itemName: 'Creator Supporter',
    amountUsd: 14.99,
    failedAt: new Date().toISOString(),
    reason: 'The card issuer declined this payment.',
    billingUrl: `${homeUrl()}/wallet`,
  },
  refund_notification: {
    name: 'Member',
    itemName: 'Premium video',
    amountUsd: 9.99,
    transactionId: 'REF-2026-0019',
    refundedAt: new Date().toISOString(),
    reason: 'Your refund request was approved.',
    walletUrl: `${homeUrl()}/wallet`,
  },
  premium_purchase_receipt: {
    name: 'Member',
    videoTitle: 'Premium video',
    creatorName: 'Creator',
    amountUsd: 9.99,
    transactionId: 'PPV-5521',
    purchasedAt: new Date().toISOString(),
    walletBalance: 480,
  },
  premium_sale_creator: {
    creatorName: 'Creator',
    buyerName: 'Member',
    videoTitle: 'Premium video',
    purchaseAmountUsd: 9.99,
    creatorEarningsUsd: 7,
    platformEarningsUsd: 2.99,
    purchasedAt: new Date().toISOString(),
  },
  gift_notification: {
    creatorName: 'Creator',
    senderName: 'Fan',
    giftName: 'Diamond',
    coinAmount: 500,
    streamTitle: 'Saturday live session',
    receivedAt: new Date().toISOString(),
  },
  live_session_notification: {
    name: 'Member',
    creatorName: 'Creator',
    streamTitle: 'Live now',
    startUrl: `${homeUrl()}/live/sample`,
    startsAt: new Date().toISOString(),
  },
  partner_verification: {
    companyName: 'Publisher Partner',
    websiteUrl: 'https://example.com',
    verificationCode: 'xsv-site-verification=abc123',
    dashboardUrl: `${homeUrl()}/partners/websites`,
  },
  content_removal_confirmation: {
    name: 'Requester',
    requestId: 'CR-2026-0142',
    contentUrl: 'https://xstreamvideos.site/video/sample',
    deadlineAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  },
  content_removal_status: {
    name: 'Requester',
    requestId: 'CR-2026-0142',
    status: 'under_review',
    statusLabel: 'Under review',
    message: 'Our Trust and Safety team has started reviewing the evidence.',
    deadlineAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  },
  content_removal_feedback: {
    name: 'Requester',
    requestId: 'CR-2026-0142',
    message: '- First issue\n- Second issue\n\nPlease update your documents.\n\nRegards,\nAdmin Team',
  },
  admin_new_creator_application: {
    adminName: 'Admin',
    creatorName: 'New Creator',
    creatorEmail: 'creator@example.com',
    submittedAt: new Date().toISOString(),
    reviewUrl: `${String(process.env.ADMIN_FRONTEND_URL || 'https://admin.xstreamvideos.site').replace(/\/$/, '')}/creator-applications`,
  },
  admin_new_report: {
    adminName: 'Admin',
    reportType: 'Content report',
    reporterEmail: 'member@example.com',
    contentTitle: 'Reported video',
    submittedAt: new Date().toISOString(),
    reportUrl: `${String(process.env.ADMIN_FRONTEND_URL || 'https://admin.xstreamvideos.site').replace(/\/$/, '')}/reports`,
  },
  admin_financial_alert: {
    adminName: 'Finance team',
    alertTitle: 'Large withdrawal pending review',
    amountUsd: 1250,
    referenceId: 'WDL-2026-0091',
    message: 'A large withdrawal request requires approval before processing.',
    actionUrl: `${String(process.env.ADMIN_FRONTEND_URL || 'https://admin.xstreamvideos.site').replace(/\/$/, '')}/finance`,
  },
  admin_system_alert: {
    adminName: 'Admin',
    alertTitle: 'Storage replication warning',
    severity: 'warning',
    message: 'Cloudflare R2 replication has failed for 3 media objects in the last hour.',
    actionUrl: `${String(process.env.ADMIN_FRONTEND_URL || 'https://admin.xstreamvideos.site').replace(/\/$/, '')}/storage-monitoring`,
  },
  notification: {
    name: 'Member',
    subject: 'Important account update',
    heading: 'Important account update',
    message: 'Your account has a new platform notification.\n\n- Review your profile\n- Check your latest activity\n- Contact support if anything looks incorrect',
    ctaLabel: 'Open dashboard',
    ctaUrl: homeUrl(),
  },
};

function rows(items) {
  return items.filter((item) => item && item.value !== undefined && item.value !== null && item.value !== '');
}

function moneyPair(amountUsd, amountNgn) {
  const usd = formatUsd(amountUsd);
  const ngn = formatNgn(amountNgn);
  return ngn ? `${usd} (${ngn})` : usd;
}

function interpolateVariables(value, variables = {}) {
  return String(value || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path) => {
    const result = String(path).split('.').reduce((acc, key) => (
      acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined
    ), variables);
    if (result === undefined || result === null) return '';
    if (Array.isArray(result)) return result.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join(', ');
    if (typeof result === 'object') return JSON.stringify(result);
    return String(result);
  });
}

function applyOverrides(layout, overrides = {}, variables = {}) {
  const allowed = ['subject', 'preheader', 'eyebrow', 'heading', 'intro', 'footerNote'];
  const next = { ...layout };
  for (const key of allowed) {
    if (typeof overrides[key] === 'string' && overrides[key].trim()) {
      next[key] = interpolateVariables(overrides[key].trim(), variables);
    }
  }
  if (typeof overrides.bodyMarkdown === 'string' && overrides.bodyMarkdown.trim()) {
    next.sections = [{ type: 'richText', value: interpolateVariables(overrides.bodyMarkdown.trim(), variables) }];
  }
  if (typeof overrides.ctaLabel === 'string' && overrides.ctaLabel.trim()) {
    next.cta = { ...(next.cta || {}), label: interpolateVariables(overrides.ctaLabel.trim(), variables) };
  }
  if (typeof overrides.ctaUrl === 'string' && overrides.ctaUrl.trim()) {
    const url = interpolateVariables(overrides.ctaUrl.trim(), variables);
    next.cta = { ...(next.cta || {}), url };
    next.fallbackUrl = url;
  }
  return next;
}

function finalize(templateKey, layout, overrides = {}, variables = {}) {
  const merged = applyOverrides(layout, overrides, variables);
  const html = renderEmailLayout({ ...merged, templateKey });
  return {
    key: templateKey,
    version: TEMPLATE_VERSION,
    subject: merged.subject,
    preheader: merged.preheader,
    html,
    text: htmlToText(html),
    meta: {
      label: getEmailTemplateMeta(templateKey)?.label || templateKey,
      category: getEmailTemplateMeta(templateKey)?.category || 'Email',
    },
  };
}

function secureActionEmail({ subject, title, preheader, eyebrow = 'Security', name, actionText, actionUrl, buttonLabel, footerNote }) {
  return {
    subject,
    title,
    preheader,
    eyebrow,
    heading: title,
    intro: `Hi ${name || 'there'},\n\n${actionText}`,
    sections: [
      {
        type: 'notice',
        variant: 'info',
        title: 'Security note',
        body: 'For your protection, this secure link may expire. If you did not request this email, you can safely ignore it.',
      },
    ],
    cta: { label: buttonLabel, url: actionUrl },
    fallbackUrl: actionUrl,
    footerNote,
  };
}

const applicationCopy = {
  submitted: {
    subject: 'Your creator application has been submitted',
    heading: 'Your creator application is under review',
    preheader: 'We received your application and will notify you when a decision is made.',
    badge: { label: 'Submitted', variant: 'info' },
    intro: 'Hi {{name}},\n\nThanks for applying to become a creator. Your application is now in review.',
    sections: [{ type: 'list', items: ['Our team will review your identity and profile details.', 'You will receive an email as soon as the status changes.', 'You can check your status from the creator application screen.'] }],
  },
  approved: {
    subject: 'You are approved to create on XstreamVideos',
    heading: 'Welcome to the creator program',
    preheader: 'Your creator application was approved. Your studio is ready.',
    badge: { label: 'Approved', variant: 'success' },
    intro: 'Hi {{name}},\n\nYour creator application has been approved. You can now publish, stream, and monetize eligible content.',
    sections: [{ type: 'list', items: ['Set up your creator profile.', 'Review your payout details.', 'Publish your first creator upload from Studio.'] }],
    cta: { label: 'Open Creator Studio', url: studioUrl() },
  },
  rejected: {
    subject: 'Update on your creator application',
    heading: 'Your creator application was not approved',
    preheader: 'We reviewed your creator application and could not approve it at this time.',
    badge: { label: 'Not approved', variant: 'danger' },
    intro: 'Hi {{name}},\n\nThank you for your interest in becoming a creator. We could not approve the application based on the current submission.',
  },
  info_requested: {
    subject: 'Action required: update your creator application',
    heading: 'We need a little more information',
    preheader: 'Please complete the missing fields so we can continue your creator review.',
    badge: { label: 'Info requested', variant: 'warning' },
    intro: 'Hi {{name}},\n\nWe need additional information before we can continue reviewing your creator application.',
  },
  reapplied: {
    subject: 'Your creator reapplication has been received',
    heading: 'Your reapplication is under review',
    preheader: 'We received your updated application.',
    badge: { label: 'Reapplied', variant: 'info' },
    intro: 'Hi {{name}},\n\nThanks for submitting your updated creator application. Our team will review the new details.',
  },
};

function buildApplication(status, vars) {
  const copy = applicationCopy[status] || applicationCopy.submitted;
  const name = vars.name || 'Creator';
  const sections = copy.sections ? [...copy.sections] : [];
  if (status === 'info_requested' && Array.isArray(vars.missingFields) && vars.missingFields.length) {
    sections.push({
      type: 'notice',
      variant: 'warning',
      title: 'Missing or incomplete fields',
      body: vars.missingFields.map((field) => `- ${field?.label || field}`).join('\n'),
    });
  }
  if (vars.reason) {
    sections.push({ type: 'notice', variant: status === 'rejected' ? 'danger' : 'neutral', title: 'Admin note', body: vars.reason });
  }

  const cta = status === 'info_requested' && vars.updateLink
    ? { label: 'Update application', url: vars.updateLink }
    : copy.cta;

  return {
    subject: copy.subject,
    title: copy.heading,
    preheader: copy.preheader,
    eyebrow: 'Creator platform',
    heading: copy.heading,
    badge: copy.badge,
    intro: copy.intro.replace('{{name}}', name),
    sections,
    cta,
    fallbackUrl: cta?.url,
  };
}

function payoutDetails(vars, title = 'Transaction details') {
  return {
    type: 'keyValue',
    title,
    rows: rows([
      { label: 'Amount', value: moneyPair(vars.amountUsd, vars.amountNgn) },
      { label: 'Bank', value: vars.bankName },
      { label: 'Account number', value: vars.accountNumber },
      { label: 'Account name', value: vars.accountName },
      { label: 'Reference', value: vars.referenceId },
    ]),
  };
}

function payoutTemplate(status, vars) {
  const amount = moneyPair(vars.amountUsd, vars.amountNgn);
  const copy = {
    requested: {
      subject: `Withdrawal request received - ${formatUsd(vars.amountUsd)}`,
      heading: 'We received your withdrawal request',
      preheader: `Your withdrawal request for ${amount} is now under review.`,
      badge: { label: 'Requested', variant: 'info' },
      body: `Hi ${vars.name || 'Creator'},\n\nYour withdrawal request for **${amount}** has been submitted and is now under review. Most requests are processed within 1-3 business days.`,
    },
    approved: {
      subject: `Withdrawal approved - ${formatUsd(vars.amountUsd)}`,
      heading: 'Your withdrawal was approved',
      preheader: `Your payout for ${amount} is now processing.`,
      badge: { label: 'Approved', variant: 'success' },
      body: `Hi ${vars.name || 'Creator'},\n\nYour withdrawal for **${amount}** has been approved and is now processing. Funds will be sent to your bank account shortly.`,
    },
    paid: {
      subject: `Payment sent - ${formatUsd(vars.amountUsd)}`,
      heading: 'Your payment has been sent',
      preheader: `Your payout for ${amount} has been sent.`,
      badge: { label: 'Paid', variant: 'success' },
      body: `Hi ${vars.name || 'Creator'},\n\nYour withdrawal for **${amount}** has been sent to your bank account. Please allow 1-2 business days for funds to appear.`,
    },
    rejected: {
      subject: `Withdrawal declined - ${formatUsd(vars.amountUsd)}`,
      heading: 'Your withdrawal was declined',
      preheader: `Your withdrawal for ${amount} could not be processed.`,
      badge: { label: 'Declined', variant: 'danger' },
      body: `Hi ${vars.name || 'Creator'},\n\nWe could not process your withdrawal for **${amount}**. The funds have been returned to your creator balance.`,
    },
  }[status];

  const sections = [{ type: 'richText', value: copy.body }, payoutDetails(vars)];
  if (status === 'rejected') {
    sections.push({ type: 'notice', variant: 'danger', title: 'Reason', body: vars.reason || 'No reason provided.' });
  }

  return {
    subject: copy.subject,
    title: copy.heading,
    preheader: copy.preheader,
    eyebrow: 'Creator payouts',
    heading: copy.heading,
    badge: copy.badge,
    sections,
    cta: status === 'rejected' ? { label: 'Open Creator Studio', url: studioUrl() } : null,
  };
}

function receiptTemplate(type, vars) {
  const paid = type === 'paid';
  const amount = formatUsd(vars.amountUsd);
  return {
    subject: paid
      ? `Payout receipt ${vars.receiptNumber} - ${amount} paid`
      : `Withdrawal declined ${vars.receiptNumber} - ${amount}`,
    title: paid ? 'Withdrawal receipt' : 'Withdrawal declined',
    preheader: paid ? `Receipt ${vars.receiptNumber} for ${amount}.` : `Declined withdrawal receipt ${vars.receiptNumber}.`,
    eyebrow: 'Finance receipt',
    heading: paid ? 'Withdrawal receipt' : 'Withdrawal declined',
    badge: { label: paid ? 'Paid' : 'Declined', variant: paid ? 'success' : 'danger' },
    sections: [
      {
        type: 'keyValue',
        title: 'Receipt summary',
        rows: rows([
          { label: 'Receipt number', value: vars.receiptNumber },
          { label: 'Creator', value: vars.creatorName },
          { label: 'Creator ID', value: vars.creatorId },
          { label: paid ? 'Paid at' : 'Declined at', value: formatDateTime(paid ? vars.paidAt : vars.rejectedAt) },
        ]),
      },
      {
        type: 'keyValue',
        title: 'Transaction breakdown',
        rows: rows([
          { label: paid ? 'Amount paid' : 'Amount requested', value: amount },
          { label: 'Remaining wallet balance', value: vars.remainingBalance == null ? 'Not available' : formatUsd(vars.remainingBalance) },
          { label: 'Payment method', value: vars.paymentMethod },
          { label: 'Transaction ID', value: vars.transactionId },
        ]),
      },
      ...(!paid ? [{ type: 'notice', variant: 'danger', title: 'Reason', body: vars.reason || 'No reason provided.' }] : []),
      {
        type: 'notice',
        variant: 'neutral',
        title: 'Company signature',
        body: `Authorized by **${vars.ceoName || 'XstreamVideos Finance'}**.\n\nKeep this receipt for your records.`,
      },
    ],
  };
}

function simpleActionTemplate({
  subject,
  heading,
  preheader,
  eyebrow,
  name,
  intro,
  badge,
  sections = [],
  ctaLabel,
  ctaUrl,
  fallbackUrl,
  footerNote,
}) {
  return {
    subject,
    title: heading,
    preheader,
    eyebrow,
    heading,
    badge,
    intro: `Hi ${name || 'there'},\n\n${intro}`,
    sections,
    cta: ctaLabel && ctaUrl ? { label: ctaLabel, url: ctaUrl } : null,
    fallbackUrl: fallbackUrl || ctaUrl,
    footerNote,
  };
}

function activityTemplate({ type, vars }) {
  const config = {
    follower: {
      subject: `${vars.followerName || 'Someone'} followed you`,
      heading: 'You have a new follower',
      preheader: `${vars.followerName || 'Someone'} started following your profile.`,
      badge: { label: 'New follower', variant: 'brand' },
      intro: `${vars.followerName || 'Someone'} started following your profile.`,
      ctaLabel: 'View profile',
      ctaUrl: vars.profileUrl || homeUrl(),
    },
    comment: {
      subject: `${vars.commenterName || 'Someone'} commented on your video`,
      heading: 'New comment on your video',
      preheader: `New comment on ${vars.videoTitle || 'your video'}.`,
      badge: { label: 'Comment', variant: 'info' },
      intro: `${vars.commenterName || 'Someone'} commented on **${vars.videoTitle || 'your video'}**.`,
      sections: [{ type: 'notice', variant: 'neutral', title: 'Comment preview', body: vars.comment || 'Open the video to read the comment.' }],
      ctaLabel: 'View comment',
      ctaUrl: vars.videoUrl || homeUrl(),
    },
    like: {
      subject: `${vars.likerName || 'Someone'} liked your video`,
      heading: 'Your video got a new like',
      preheader: `${vars.videoTitle || 'Your video'} received a like.`,
      badge: { label: 'Like', variant: 'success' },
      intro: `${vars.likerName || 'Someone'} liked **${vars.videoTitle || 'your video'}**.`,
      ctaLabel: 'View video',
      ctaUrl: vars.videoUrl || homeUrl(),
    },
    message: {
      subject: `New message from ${vars.senderName || 'XstreamVideos'}`,
      heading: 'You have a new message',
      preheader: vars.messagePreview || 'Open your inbox to read the message.',
      badge: { label: 'Message', variant: 'info' },
      intro: `${vars.senderName || 'Someone'} sent you a message.`,
      sections: [{ type: 'notice', variant: 'neutral', title: 'Preview', body: vars.messagePreview || 'Open your inbox to read the message.' }],
      ctaLabel: 'Open messages',
      ctaUrl: vars.messagesUrl || `${homeUrl()}/messages`,
    },
  }[type];

  return simpleActionTemplate({
    ...config,
    eyebrow: 'Activity',
    name: vars.name,
    sections: config.sections || [],
  });
}

function contentReviewTemplate(status, vars) {
  const approved = status === 'approved';
  return simpleActionTemplate({
    subject: approved ? 'Your content was approved' : 'Your content needs changes',
    heading: approved ? 'Your content is approved' : 'Your content was not approved',
    preheader: approved
      ? `${vars.videoTitle || 'Your upload'} is approved and ready for viewers.`
      : `${vars.videoTitle || 'Your upload'} needs changes before publishing.`,
    eyebrow: 'Creator content',
    name: vars.creatorName || vars.name || 'Creator',
    badge: { label: approved ? 'Approved' : 'Needs changes', variant: approved ? 'success' : 'danger' },
    intro: approved
      ? `**${vars.videoTitle || 'Your upload'}** has passed review and can now be viewed on the platform.`
      : `**${vars.videoTitle || 'Your upload'}** could not be approved based on the current submission.`,
    sections: [
      {
        type: 'keyValue',
        title: 'Content details',
        rows: rows([
          { label: 'Title', value: vars.videoTitle },
          { label: 'Reviewed at', value: formatDateTime(vars.reviewedAt) },
        ]),
      },
      ...(!approved ? [{ type: 'notice', variant: 'danger', title: 'Reason', body: vars.reason || 'Please review the platform content policy and resubmit.' }] : []),
    ],
    ctaLabel: approved ? 'View content' : 'Edit and resubmit',
    ctaUrl: approved ? (vars.contentUrl || homeUrl()) : (vars.editUrl || studioUrl()),
  });
}

function purchaseTemplate(kind, vars) {
  const item = vars.itemName || vars.productName || vars.videoTitle || 'Purchase';
  const copy = {
    purchase: {
      subject: `Purchase confirmed - ${item}`,
      heading: 'Purchase confirmed',
      preheader: `Your purchase of ${item} is complete.`,
      badge: { label: 'Purchased', variant: 'success' },
      intro: `Your purchase of **${item}** was completed successfully.`,
      ctaLabel: 'View purchase',
      ctaUrl: vars.receiptUrl || vars.purchaseUrl || `${homeUrl()}/wallet`,
    },
    subscription_confirmation: {
      subject: `Subscription confirmed - ${vars.planName || 'Plan'}`,
      heading: 'Subscription confirmed',
      preheader: `${vars.planName || 'Your plan'} is now active.`,
      badge: { label: 'Active', variant: 'success' },
      intro: `Your **${vars.planName || 'subscription'}** is now active.`,
      ctaLabel: 'Manage subscription',
      ctaUrl: vars.manageUrl || `${homeUrl()}/wallet`,
    },
    subscription_renewal: {
      subject: `Subscription renewed - ${vars.planName || 'Plan'}`,
      heading: 'Subscription renewed',
      preheader: `${vars.planName || 'Your plan'} renewed successfully.`,
      badge: { label: 'Renewed', variant: 'success' },
      intro: `Your **${vars.planName || 'subscription'}** renewed successfully.`,
      ctaLabel: 'Manage subscription',
      ctaUrl: vars.manageUrl || `${homeUrl()}/wallet`,
    },
    failed_payment: {
      subject: 'Payment failed',
      heading: 'Payment failed',
      preheader: `We could not complete payment for ${item}.`,
      badge: { label: 'Failed', variant: 'danger' },
      intro: `We could not complete payment for **${item}**.`,
      ctaLabel: 'Update payment',
      ctaUrl: vars.billingUrl || `${homeUrl()}/wallet`,
    },
    refund: {
      subject: `Refund processed - ${item}`,
      heading: 'Refund processed',
      preheader: `Your refund for ${item} has been processed.`,
      badge: { label: 'Refunded', variant: 'info' },
      intro: `Your refund for **${item}** has been processed. Any related paid access may no longer be available.`,
      ctaLabel: 'Open wallet',
      ctaUrl: vars.walletUrl || `${homeUrl()}/wallet`,
    },
  }[kind];

  const detailRows = rows([
    { label: 'Item', value: item || vars.planName },
    { label: 'Plan', value: vars.planName },
    { label: 'Amount', value: vars.amountUsd == null ? null : formatUsd(vars.amountUsd) },
    { label: 'Transaction ID', value: vars.transactionId },
    { label: 'Purchased at', value: vars.purchasedAt ? formatDateTime(vars.purchasedAt) : null },
    { label: 'Renewed at', value: vars.renewedAt ? formatDateTime(vars.renewedAt) : null },
    { label: 'Refunded at', value: vars.refundedAt ? formatDateTime(vars.refundedAt) : null },
    { label: 'Failed at', value: vars.failedAt ? formatDateTime(vars.failedAt) : null },
    { label: 'Next renewal', value: vars.nextRenewalDate || vars.renewalDate ? formatDateTime(vars.nextRenewalDate || vars.renewalDate) : null },
  ]);

  const sections = [{ type: 'keyValue', title: 'Details', rows: detailRows }];
  if (vars.reason || kind === 'failed_payment') {
    sections.push({
      type: 'notice',
      variant: kind === 'failed_payment' ? 'danger' : 'neutral',
      title: kind === 'failed_payment' ? 'Reason' : 'Note',
      body: vars.reason || 'The payment provider declined the transaction.',
    });
  }

  return simpleActionTemplate({
    ...copy,
    eyebrow: 'Payments',
    name: vars.name,
    sections,
  });
}

function adminAlertTemplate(kind, vars) {
  const config = {
    creator: {
      subject: 'New creator application',
      heading: 'New creator application',
      preheader: `${vars.creatorName || 'A creator'} submitted an application.`,
      badge: { label: 'Review', variant: 'info' },
      intro: `${vars.creatorName || 'A creator'} submitted a creator application that needs review.`,
      ctaLabel: 'Review application',
      ctaUrl: vars.reviewUrl || `${adminUrl()}/creator-applications`,
      rows: [
        { label: 'Creator', value: vars.creatorName },
        { label: 'Email', value: vars.creatorEmail },
        { label: 'Submitted at', value: formatDateTime(vars.submittedAt) },
      ],
    },
    report: {
      subject: 'New platform report',
      heading: 'New report requires review',
      preheader: `${vars.reportType || 'A report'} was submitted.`,
      badge: { label: 'Report', variant: 'warning' },
      intro: 'A new platform report requires admin review.',
      ctaLabel: 'Open report',
      ctaUrl: vars.reportUrl || `${adminUrl()}/reports`,
      rows: [
        { label: 'Report type', value: vars.reportType },
        { label: 'Reporter', value: vars.reporterEmail },
        { label: 'Content', value: vars.contentTitle },
        { label: 'Submitted at', value: formatDateTime(vars.submittedAt) },
      ],
    },
    finance: {
      subject: vars.alertTitle || 'Financial alert',
      heading: vars.alertTitle || 'Financial alert',
      preheader: vars.message || 'A financial event requires attention.',
      badge: { label: 'Finance', variant: 'warning' },
      intro: vars.message || 'A financial event requires attention.',
      ctaLabel: 'Open finance dashboard',
      ctaUrl: vars.actionUrl || `${adminUrl()}/finance`,
      rows: [
        { label: 'Amount', value: vars.amountUsd == null ? null : formatUsd(vars.amountUsd) },
        { label: 'Reference', value: vars.referenceId },
      ],
    },
    system: {
      subject: vars.alertTitle || 'System alert',
      heading: vars.alertTitle || 'System alert',
      preheader: vars.message || 'A system event requires attention.',
      badge: { label: vars.severity || 'Alert', variant: String(vars.severity || '').toLowerCase() === 'critical' ? 'danger' : 'warning' },
      intro: vars.message || 'A system event requires attention.',
      ctaLabel: 'Open system dashboard',
      ctaUrl: vars.actionUrl || `${adminUrl()}/it-operations`,
      rows: [
        { label: 'Severity', value: vars.severity },
      ],
    },
  }[kind];

  return simpleActionTemplate({
    ...config,
    eyebrow: 'Admin alert',
    name: vars.adminName || 'Admin',
    sections: [{ type: 'keyValue', title: 'Summary', rows: rows(config.rows) }],
  });
}

const builders = {
  welcome: (vars) => simpleActionTemplate({
    subject: 'Welcome to XstreamVideos',
    heading: 'Welcome to XstreamVideos',
    preheader: 'Your account is ready.',
    eyebrow: 'Welcome',
    name: vars.name,
    badge: { label: 'Account ready', variant: 'success' },
    intro: 'Your account is ready. You can now explore videos, follow creators, and manage your wallet from one secure place.',
    sections: [{ type: 'list', items: ['Complete your profile.', 'Follow creators you like.', 'Keep your account secure with a verified email.'] }],
    ctaLabel: 'Start watching',
    ctaUrl: vars.dashboardUrl || homeUrl(),
  }),

  email_verification: (vars) => secureActionEmail({
    subject: 'Verify your email address',
    title: 'Verify your email address',
    preheader: 'Confirm your email address to activate your account.',
    name: vars.name || 'there',
    actionText: 'Thanks for creating an account. Confirm your email address to activate your account and protect your login.',
    actionUrl: vars.verificationUrl,
    buttonLabel: 'Verify email address',
    footerNote: 'This verification link expires after 24 hours.',
  }),

  login_alert: (vars) => simpleActionTemplate({
    subject: 'New login to your XstreamVideos account',
    heading: 'New login detected',
    preheader: `A login was detected from ${vars.device || 'a new device'}.`,
    eyebrow: 'Security',
    name: vars.name,
    badge: { label: 'Security', variant: 'warning' },
    intro: 'We noticed a login to your account. Review the details below.',
    sections: [
      {
        type: 'keyValue',
        title: 'Login details',
        rows: rows([
          { label: 'Time', value: formatDateTime(vars.loginTime) },
          { label: 'Device', value: vars.device },
          { label: 'Location', value: vars.location },
          { label: 'IP address', value: vars.ipAddress },
        ]),
      },
      { type: 'notice', variant: 'warning', title: 'Was this not you?', body: 'Reset your password and contact support immediately if you do not recognize this activity.' },
    ],
    ctaLabel: 'Review security',
    ctaUrl: vars.securityUrl || `${homeUrl()}/account/security`,
  }),

  account_recovery: (vars) => simpleActionTemplate({
    subject: 'Recover your XstreamVideos account',
    heading: 'Recover your account',
    preheader: 'Use this secure link to recover account access.',
    eyebrow: 'Security',
    name: vars.name,
    badge: { label: 'Recovery', variant: 'info' },
    intro: 'Use the secure button below to continue account recovery. This link is time-limited for your protection.',
    sections: vars.expiresAt ? [{ type: 'keyValue', title: 'Recovery details', rows: [{ label: 'Expires', value: formatDateTime(vars.expiresAt) }] }] : [],
    ctaLabel: 'Recover account',
    ctaUrl: vars.recoveryUrl,
    footerNote: 'If you did not request recovery, you can safely ignore this email.',
  }),

  password_reset: (vars) => secureActionEmail({
    subject: 'Reset your XstreamVideos password',
    title: 'Reset your password',
    preheader: 'Use this secure link to choose a new password.',
    name: vars.name || 'there',
    actionText: 'We received a request to reset your password. Use the secure button below to choose a new password.',
    actionUrl: vars.resetUrl,
    buttonLabel: 'Choose a new password',
  }),

  new_follower: (vars) => activityTemplate({ type: 'follower', vars }),
  new_comment: (vars) => activityTemplate({ type: 'comment', vars }),
  new_like: (vars) => activityTemplate({ type: 'like', vars }),
  new_message: (vars) => activityTemplate({ type: 'message', vars }),
  account_update: (vars) => simpleActionTemplate({
    subject: vars.updateTitle || 'Account update',
    heading: vars.updateTitle || 'Account update',
    preheader: vars.message || 'Your account has an update.',
    eyebrow: 'Account',
    name: vars.name,
    badge: { label: 'Update', variant: 'info' },
    intro: vars.message || 'Your account has an update.',
    ctaLabel: vars.actionLabel || 'Review account',
    ctaUrl: vars.actionUrl || `${homeUrl()}/account`,
  }),

  otp: (vars) => ({
    subject: 'Your XstreamVideos verification code',
    title: 'Your verification code',
    preheader: 'Use this one-time code to continue.',
    eyebrow: 'Security',
    heading: 'Your verification code',
    intro: 'Use the code below to verify your identity. It expires in 5 minutes.',
    sections: [
      {
        type: 'html',
        html: `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0;"><tr><td align="center"><div style="display:inline-block;background:#F3F4F6;border:1px solid #E5E7EB;border-radius:14px;padding:20px 28px;font-size:34px;line-height:1;font-weight:900;letter-spacing:8px;color:#111827;font-family:Menlo,Consolas,monospace;">${escapeHtml(vars.otp || '')}</div></td></tr></table>`,
      },
      { type: 'notice', variant: 'neutral', title: 'Security note', body: 'If you did not request this code, you can safely ignore this email.' },
    ],
  }),

  admin_invite: (vars) => ({
    subject: 'You have been invited to XstreamVideos Admin',
    title: 'You have been invited',
    preheader: 'Complete your admin account using this secure invite.',
    eyebrow: 'Admin',
    heading: 'You have been invited',
    intro: `Hi ${vars.name || 'Admin'},\n\nYou have been invited to join the XstreamVideos admin panel. Complete your account using the secure link below.`,
    sections: Array.isArray(vars.permissions) && vars.permissions.length
      ? [{ type: 'notice', variant: 'info', title: 'Your access', body: vars.permissions.map((permission) => `- ${permission}`).join('\n') }]
      : [],
    cta: { label: 'Complete admin account', url: vars.inviteUrl },
    fallbackUrl: vars.inviteUrl,
  }),

  account_deletion: (vars) => ({
    subject: 'Your XstreamVideos account has been deleted',
    title: 'Your account has been deleted',
    preheader: 'An administrator removed your account.',
    eyebrow: 'Account notice',
    heading: 'Your account has been deleted',
    intro: `Hi ${vars.name || 'there'},\n\nYour account has been removed from XstreamVideos by an administrator.`,
    sections: [{ type: 'notice', variant: 'danger', title: 'Reason provided', body: vars.reason || 'No reason was provided.' }],
    cta: { label: 'Create a new account', url: vars.platformUrl || homeUrl() },
    fallbackUrl: vars.platformUrl || homeUrl(),
  }),

  creator_application_submitted: (vars) => buildApplication('submitted', vars),
  creator_application_approved: (vars) => buildApplication('approved', vars),
  creator_application_rejected: (vars) => buildApplication('rejected', vars),
  creator_application_info_requested: (vars) => buildApplication('info_requested', vars),
  creator_application_reapplied: (vars) => buildApplication('reapplied', vars),
  content_approved: (vars) => contentReviewTemplate('approved', vars),
  content_rejected: (vars) => contentReviewTemplate('rejected', vars),

  withdrawal_requested: (vars) => payoutTemplate('requested', vars),
  withdrawal_approved: (vars) => payoutTemplate('approved', vars),
  withdrawal_paid: (vars) => payoutTemplate('paid', vars),
  withdrawal_rejected: (vars) => payoutTemplate('rejected', vars),
  withdrawal_receipt_paid: (vars) => receiptTemplate('paid', vars),
  withdrawal_receipt_rejected: (vars) => receiptTemplate('rejected', vars),

  payment_success: (vars) => ({
    subject: `Payment successful - ${formatUsd(vars.amountUsd)}`,
    title: 'Payment successful',
    preheader: `Your payment for ${vars.productName || 'your purchase'} was successful.`,
    eyebrow: 'Payments',
    heading: 'Payment successful',
    badge: { label: 'Paid', variant: 'success' },
    intro: `Hi ${vars.name || 'there'},\n\nYour payment was completed successfully.`,
    sections: [{
      type: 'keyValue',
      title: 'Receipt',
      rows: rows([
        { label: 'Item', value: vars.productName },
        { label: 'Amount', value: formatUsd(vars.amountUsd) },
        { label: 'Provider', value: vars.provider },
        { label: 'Transaction ID', value: vars.transactionId },
        { label: 'Paid at', value: formatDateTime(vars.paidAt) },
        { label: 'Wallet balance', value: vars.walletBalance == null ? null : `${vars.walletBalance} coins` },
      ]),
    }],
  }),

  payment_failure: (vars) => ({
    subject: 'Payment failed',
    title: 'Payment failed',
    preheader: `We could not complete payment for ${vars.productName || 'your purchase'}.`,
    eyebrow: 'Payments',
    heading: 'Payment failed',
    badge: { label: 'Failed', variant: 'danger' },
    intro: `Hi ${vars.name || 'there'},\n\nWe could not complete your payment. No access was granted and you have not been charged by XstreamVideos for this failed attempt.`,
    sections: [
      {
        type: 'keyValue',
        title: 'Attempt details',
        rows: rows([
          { label: 'Item', value: vars.productName },
          { label: 'Amount', value: formatUsd(vars.amountUsd) },
          { label: 'Transaction ID', value: vars.transactionId },
          { label: 'Failed at', value: formatDateTime(vars.failedAt) },
        ]),
      },
      { type: 'notice', variant: 'danger', title: 'Reason', body: vars.reason || 'The payment provider declined the transaction.' },
    ],
    cta: { label: 'Try again', url: homeUrl() },
  }),

  purchase_confirmation: (vars) => purchaseTemplate('purchase', vars),
  subscription_confirmation: (vars) => purchaseTemplate('subscription_confirmation', vars),
  subscription_renewal: (vars) => purchaseTemplate('subscription_renewal', vars),
  failed_payment: (vars) => purchaseTemplate('failed_payment', vars),
  refund_notification: (vars) => purchaseTemplate('refund', vars),

  premium_purchase_receipt: (vars) => ({
    subject: `Premium video purchase receipt - ${formatUsd(vars.amountUsd)}`,
    title: 'Premium purchase receipt',
    preheader: `You purchased ${vars.videoTitle || 'a premium video'}.`,
    eyebrow: 'Premium',
    heading: 'Premium purchase receipt',
    badge: { label: 'Purchased', variant: 'success' },
    intro: `Hi ${vars.name || 'there'},\n\nYour premium video purchase is complete.`,
    sections: [{
      type: 'keyValue',
      title: 'Purchase',
      rows: rows([
        { label: 'Video', value: vars.videoTitle },
        { label: 'Creator', value: vars.creatorName },
        { label: 'Amount', value: formatUsd(vars.amountUsd) },
        { label: 'Transaction ID', value: vars.transactionId },
        { label: 'Purchased at', value: formatDateTime(vars.purchasedAt) },
        { label: 'Wallet balance', value: vars.walletBalance == null ? null : `${vars.walletBalance} coins` },
      ]),
    }],
  }),

  premium_sale_creator: (vars) => ({
    subject: `You earned ${formatUsd(vars.creatorEarningsUsd)} from a premium sale`,
    title: 'Premium sale earning',
    preheader: `${vars.buyerName || 'A member'} purchased ${vars.videoTitle || 'your premium video'}.`,
    eyebrow: 'Creator earnings',
    heading: 'You made a premium sale',
    badge: { label: 'Earning', variant: 'success' },
    intro: `Hi ${vars.creatorName || 'Creator'},\n\n${vars.buyerName || 'A member'} purchased your premium video.`,
    sections: [{
      type: 'keyValue',
      title: 'Sale breakdown',
      rows: rows([
        { label: 'Video', value: vars.videoTitle },
        { label: 'Sale total', value: formatUsd(vars.purchaseAmountUsd) },
        { label: 'Your earnings', value: formatUsd(vars.creatorEarningsUsd) },
        { label: 'Platform share', value: formatUsd(vars.platformEarningsUsd) },
        { label: 'Purchased at', value: formatDateTime(vars.purchasedAt) },
      ]),
    }],
    cta: { label: 'Open Creator Studio', url: studioUrl() },
  }),

  gift_notification: (vars) => ({
    subject: `${vars.senderName || 'A viewer'} sent you a gift`,
    title: 'You received a live gift',
    preheader: `${vars.giftName || 'A gift'} was sent during ${vars.streamTitle || 'your live session'}.`,
    eyebrow: 'Live gifts',
    heading: 'You received a live gift',
    badge: { label: 'Gift received', variant: 'success' },
    intro: `Hi ${vars.creatorName || 'Creator'},\n\n${vars.senderName || 'A viewer'} sent you a gift during your live session.`,
    sections: [{
      type: 'keyValue',
      title: 'Gift details',
      rows: rows([
        { label: 'Gift', value: vars.giftName },
        { label: 'Coins', value: vars.coinAmount == null ? null : `${vars.coinAmount} coins` },
        { label: 'Stream', value: vars.streamTitle },
        { label: 'Received at', value: formatDateTime(vars.receivedAt) },
      ]),
    }],
    cta: { label: 'Open Creator Studio', url: studioUrl() },
  }),

  live_session_notification: (vars) => ({
    subject: `${vars.creatorName || 'A creator'} is live`,
    title: 'Live session notification',
    preheader: `${vars.creatorName || 'A creator'} is live now.`,
    eyebrow: 'Live',
    heading: `${vars.creatorName || 'A creator'} is live`,
    badge: { label: 'Live now', variant: 'brand' },
    intro: `Hi ${vars.name || 'there'},\n\n${vars.creatorName || 'A creator'} started a live session: **${vars.streamTitle || 'Live now'}**.`,
    sections: [{ type: 'keyValue', title: 'Session', rows: rows([{ label: 'Starts at', value: formatDateTime(vars.startsAt) }]) }],
    cta: { label: 'Watch live', url: vars.startUrl || homeUrl() },
    fallbackUrl: vars.startUrl || homeUrl(),
  }),

  partner_verification: (vars) => ({
    subject: 'Verify your partner website',
    title: 'Verify your partner website',
    preheader: 'Add the verification code to your website to complete setup.',
    eyebrow: 'Partners',
    heading: 'Verify your partner website',
    intro: `Hi ${vars.companyName || 'Partner'},\n\nAdd the verification code below to your website so we can verify ownership.`,
    sections: [
      {
        type: 'keyValue',
        title: 'Website',
        rows: rows([
          { label: 'Website URL', value: vars.websiteUrl },
          { label: 'Verification code', value: vars.verificationCode },
        ]),
      },
      { type: 'notice', variant: 'info', title: 'Instructions', body: '- Add the code as a meta tag or visible text on your homepage.\n- Return to the partner dashboard.\n- Click verify once the code is live.' },
    ],
    cta: { label: 'Open partner dashboard', url: vars.dashboardUrl || `${homeUrl()}/partners` },
    fallbackUrl: vars.dashboardUrl || `${homeUrl()}/partners`,
  }),

  content_removal_confirmation: (vars) => ({
    subject: `Content removal request received - ${vars.requestId}`,
    title: 'Content removal request received',
    preheader: 'Your Trust and Safety request has been received.',
    eyebrow: 'Trust and Safety',
    heading: 'Your request has been received',
    intro: `Hi ${vars.name || 'there'},\n\nWe received your content removal application. The review process has started.`,
    sections: [
      {
        type: 'keyValue',
        title: 'Request details',
        rows: rows([
          { label: 'Request ID', value: vars.requestId },
          { label: 'Content URL', value: vars.contentUrl },
          { label: 'Target decision date', value: formatDateTime(vars.deadlineAt) },
        ]),
      },
      { type: 'notice', variant: 'neutral', title: 'Keep this ID', body: 'Please keep your Request ID for future correspondence. We may contact you if more evidence is required.' },
    ],
  }),

  content_removal_status: (vars) => ({
    subject: `Content removal request updated - ${vars.requestId}`,
    title: 'Content removal request updated',
    preheader: `Status: ${vars.statusLabel || vars.status || 'Updated'}.`,
    eyebrow: 'Trust and Safety',
    heading: vars.statusLabel || 'Request updated',
    badge: { label: vars.statusLabel || vars.status || 'Updated', variant: vars.status === 'rejected' ? 'danger' : vars.status === 'approved' ? 'success' : 'info' },
    intro: `Hi ${vars.name || 'there'},\n\nYour content removal request has a new status update.`,
    sections: [
      {
        type: 'keyValue',
        title: 'Request details',
        rows: rows([
          { label: 'Request ID', value: vars.requestId },
          { label: 'Current status', value: vars.statusLabel || vars.status },
          { label: 'Target decision date', value: formatDateTime(vars.deadlineAt) },
        ]),
      },
      { type: 'notice', variant: 'brand', title: 'Admin message', body: vars.message || 'No additional message was provided.' },
    ],
  }),

  content_removal_feedback: (vars) => ({
    subject: `Message about your content removal request - ${vars.requestId}`,
    title: 'Admin feedback',
    preheader: 'A Trust and Safety admin sent you a message.',
    eyebrow: 'Trust and Safety',
    heading: 'Admin feedback',
    intro: `Hi ${vars.name || 'there'},\n\nOur Trust and Safety team sent a message about your request.`,
    sections: [
      { type: 'keyValue', title: 'Request', rows: rows([{ label: 'Request ID', value: vars.requestId }]) },
      { type: 'notice', variant: 'brand', title: 'Message', body: vars.message || 'No message was provided.' },
    ],
  }),

  admin_new_creator_application: (vars) => adminAlertTemplate('creator', vars),
  admin_new_report: (vars) => adminAlertTemplate('report', vars),
  admin_financial_alert: (vars) => adminAlertTemplate('finance', vars),
  admin_system_alert: (vars) => adminAlertTemplate('system', vars),

  notification: (vars) => ({
    subject: vars.subject || 'Notification from XstreamVideos',
    title: vars.heading || vars.subject || 'Notification',
    preheader: vars.preheader || 'You have a new platform notification.',
    eyebrow: vars.eyebrow || 'Notification',
    heading: vars.heading || vars.subject || 'Notification',
    intro: `Hi ${vars.name || 'there'},`,
    sections: [{ type: 'richText', value: vars.message || 'You have a new platform notification.' }],
    cta: vars.ctaLabel && vars.ctaUrl ? { label: vars.ctaLabel, url: vars.ctaUrl } : null,
    fallbackUrl: vars.ctaUrl,
  }),
};

export function listEmailTemplates() {
  return REGISTRY.map((template) => ({
    ...template,
    sampleData: sampleDataForTemplate(template.key),
  }));
}

export function getEmailTemplateMeta(key) {
  return REGISTRY.find((template) => template.key === key) || null;
}

export function sampleDataForTemplate(key) {
  return JSON.parse(JSON.stringify(SAMPLE_DATA[key] || {}));
}

export function templateKeyForApplicationStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'approved') return 'creator_application_approved';
  if (normalized === 'rejected') return 'creator_application_rejected';
  if (normalized === 'info_requested') return 'creator_application_info_requested';
  if (normalized === 'reapplied') return 'creator_application_reapplied';
  return 'creator_application_submitted';
}

export function renderEmailTemplate(templateKey, variables = {}, options = {}) {
  const key = String(templateKey || '').trim();
  const builder = builders[key];
  if (!builder) {
    const known = REGISTRY.map((template) => template.key).join(', ');
    throw new Error(`Unknown email template "${escapeHtml(key)}". Known templates: ${known}`);
  }
  const vars = {
    ...sampleDataForTemplate(key),
    ...(variables || {}),
  };
  const rendered = finalize(key, builder(vars), options.overrides || {}, vars);
  return {
    ...rendered,
    variables: vars,
  };
}

export function renderNotificationEmail({ subject, heading, message, name, ctaLabel, ctaUrl, eyebrow = 'Notification' }) {
  return renderEmailTemplate('notification', {
    subject,
    heading,
    message,
    name,
    ctaLabel,
    ctaUrl: safeUrl(ctaUrl, ''),
    eyebrow,
  });
}
