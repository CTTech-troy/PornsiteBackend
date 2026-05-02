import { Resend } from 'resend';

let resendClient = null;

function getResend() {
  if (!resendClient && process.env.RESEND_API_KEY) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

function buildVerificationEmailHtml({ name, verificationUrl, logoUrl }) {
  const safeName = String(name || 'there').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const safeUrl  = String(verificationUrl || '#').replace(/"/g, '%22');
  const logo     = logoUrl ? `<img src="${logoUrl.replace(/"/g, '%22')}" alt="Xstream" width="48" height="48" style="border-radius:8px;" />` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Verify your email address</title>
</head>
<body style="margin:0;padding:0;background:#F0F2F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F2F5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1A1A2E 0%,#16213E 100%);padding:32px 40px;text-align:center;">
              ${logo ? `<div style="margin-bottom:16px;">${logo}</div>` : ''}
              <span style="color:#FF4654;font-size:24px;font-weight:900;letter-spacing:-0.5px;">Xstream</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#1A1A2E;letter-spacing:-0.3px;">
                Verify your email address
              </h1>
              <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.6;">
                Hi ${safeName},
              </p>
              <p style="margin:0 0 32px;font-size:15px;color:#374151;line-height:1.7;">
                Thank you for creating an account. Please verify your email address to activate your account and start using the platform.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:32px;">
                    <a href="${safeUrl}"
                       style="display:inline-block;background:linear-gradient(135deg,#FF4654 0%,#FF7043 100%);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:10px;box-shadow:0 4px 12px rgba(255,70,84,0.35);">
                      Verify Email Address
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;font-size:13px;color:#9CA3AF;line-height:1.6;">
                This link will expire in <strong>1 hour</strong>. If you did not create this account, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Fallback link -->
          <tr>
            <td style="padding:0 40px 32px;">
              <div style="border-top:1px solid #E5E7EB;padding-top:24px;">
                <p style="margin:0 0 8px;font-size:12px;color:#9CA3AF;">
                  If the button above doesn't work, copy and paste this link into your browser:
                </p>
                <p style="margin:0;font-size:12px;color:#FF4654;word-break:break-all;">
                  <a href="${safeUrl}" style="color:#FF4654;">${safeUrl}</a>
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#F9FAFB;padding:20px 40px;text-align:center;border-top:1px solid #E5E7EB;">
              <p style="margin:0;font-size:12px;color:#9CA3AF;">
                &copy; ${new Date().getFullYear()} Xstream. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendVerificationEmail({ to, name, verificationUrl }) {
  const resend = getResend();
  if (!resend) {
    console.error('[email] ✗ Email service not configured — RESEND_API_KEY is missing.');
    throw new Error('Email service not configured — set RESEND_API_KEY in environment.');
  }

  const logoUrl = process.env.COMPANY_LOGO_URL || null;
  const html    = buildVerificationEmailHtml({ name, verificationUrl, logoUrl });
  // Fall back to Resend's built-in test sender when no verified domain is configured.
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  // Validate the from address early — catches typos like "name.domain.com" (missing @).
  const emailInFrom = from.includes('<') ? from.match(/<([^>]+)>/)?.[1] : from;
  if (!emailInFrom || !emailInFrom.includes('@')) {
    const msg = `[email] ✗ RESEND_FROM_EMAIL is misconfigured: "${from}" — must contain a valid email address (e.g. Xstream <no-reply@yourdomain.com>)`;
    console.error(msg);
    throw new Error(msg);
  }

  console.log(`[email] → Sending verification email to: ${to}`);
  const t0 = Date.now();

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: 'Verify your email address',
    html,
  });

  if (error) {
    console.error(`[email] ✗ Failed to send to ${to} — ${error.message}`);
    throw new Error(`Resend error: ${error.message}`);
  }

  console.log(`[email] ✓ Verification email sent to ${to} (id: ${data?.id ?? 'n/a'}, ${Date.now() - t0}ms)`);
}

export async function sendAdminInviteEmail({ to, name, inviteUrl, permissions }) {
  const resend = getResend();
  if (!resend) {
    console.error('[email] ✗ Email service not configured — RESEND_API_KEY is missing.');
    throw new Error('Email service not configured — set RESEND_API_KEY in environment.');
  }
  const safeName = String(name || 'Admin').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const safeUrl = String(inviteUrl || '#').replace(/"/g, '%22');
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const permissionList = Array.isArray(permissions) && permissions.length > 0
    ? `<ul style="margin:8px 0 0 0;padding-left:20px;color:#374151;font-size:14px;">${permissions.map(p => `<li style="margin-bottom:4px;">${p}</li>`).join('')}</ul>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Admin Invite</title></head>
<body style="margin:0;padding:0;background:#F0F2F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F2F5;padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.08);">
      <tr><td style="background:linear-gradient(135deg,#1A1A2E 0%,#16213E 100%);padding:32px 40px;text-align:center;">
        <span style="color:#FF4654;font-size:24px;font-weight:900;letter-spacing:-0.5px;">Xstream Admin</span>
      </td></tr>
      <tr><td style="padding:40px 40px 32px;">
        <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#1A1A2E;">You've been invited</h1>
        <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.7;">Hi ${safeName}, you've been invited to join the Xstream admin panel. This link expires in <strong>10 minutes</strong>.</p>
        ${permissionList ? `<div style="background:#F9FAFB;border-radius:8px;padding:16px;margin-bottom:24px;"><p style="margin:0;font-size:13px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Your Access</p>${permissionList}</div>` : ''}
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:32px;">
          <a href="${safeUrl}" style="display:inline-block;background:linear-gradient(135deg,#FF4654 0%,#FF7043 100%);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:10px;box-shadow:0 4px 12px rgba(255,70,84,0.35);">Complete Your Admin Account</a>
        </td></tr></table>
        <p style="margin:0;font-size:12px;color:#9CA3AF;">If the button doesn't work, copy: <a href="${safeUrl}" style="color:#FF4654;">${safeUrl}</a></p>
      </td></tr>
      <tr><td style="background:#F9FAFB;padding:20px 40px;text-align:center;border-top:1px solid #E5E7EB;">
        <p style="margin:0;font-size:12px;color:#9CA3AF;">&copy; ${new Date().getFullYear()} Xstream. All rights reserved.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  const { data, error } = await resend.emails.send({ from, to, subject: 'You have been invited to Xstream Admin', html });
  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[email] ✓ Admin invite sent to ${to} (id: ${data?.id ?? 'n/a'})`);
}

export async function sendApplicationDecisionEmail({ to, name, status, reason, missingFields = [], updateLink = null }) {
  const resend = getResend();
  if (!resend) return; // silently skip if not configured
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const esc = (s) => String(s || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const safeName = esc(name || 'Creator');
  const safeReason = esc(reason || '');
  const safeUpdateLink = String(updateLink || '').replace(/"/g, '%22');

  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';
  const isInfoRequest = status === 'info_requested';

  const statusConfig = isApproved
    ? { emoji: '🎉', heading: 'Congratulations! Your application has been approved.', color: '#10B981', badge: 'Approved',
        message: 'Welcome to the XstreamVideos creator family! You can now start creating and monetizing your content. Head to your dashboard to set up your creator profile and begin streaming.' }
    : isRejected
    ? { emoji: '😔', heading: 'Your creator application was not approved.', color: '#EF4444', badge: 'Not Approved',
        message: 'We appreciate your interest in joining XstreamVideos as a creator. Unfortunately, your application did not meet our current requirements. You are welcome to reapply in the future.' }
    : { emoji: '📋', heading: 'Additional information required for your application.', color: '#F59E0B', badge: 'Info Requested',
        message: 'Thank you for applying to become a creator on XstreamVideos! We need a bit more information before we can process your application. Please use the link below to provide the missing details.' };

  // Build missing-fields list for info_requested emails
  const missingFieldsHtml = isInfoRequest && missingFields.length > 0
    ? `<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:#92400E;text-transform:uppercase;letter-spacing:0.05em;">Missing or incomplete fields</p>
        <ul style="margin:0;padding-left:20px;">${missingFields.map(f => `<li style="font-size:14px;color:#374151;margin-bottom:4px;">${esc(f.label)}</li>`).join('')}</ul>
      </div>`
    : '';

  // Update-link button (info_requested only)
  const updateLinkHtml = isInfoRequest && safeUpdateLink
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr><td align="center">
        <a href="${safeUpdateLink}" style="display:inline-block;background:linear-gradient(135deg,#F59E0B 0%,#F97316 100%);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:10px;box-shadow:0 4px 12px rgba(245,158,11,0.35);">Update My Application</a>
      </td></tr></table>
      <p style="margin:0 0 24px;font-size:12px;color:#9CA3AF;text-align:center;">This link expires in 7 days. If the button doesn't work, copy: <a href="${safeUpdateLink}" style="color:#F59E0B;word-break:break-all;">${safeUpdateLink}</a></p>`
    : '';

  // Dashboard button (approved only)
  const dashboardHtml = isApproved
    ? `<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:8px;">
        <a href="${process.env.FRONTEND_URL || 'https://xstreamvideos.site'}/studio" style="display:inline-block;background:linear-gradient(135deg,#FF4654 0%,#FF7043 100%);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:10px;box-shadow:0 4px 12px rgba(255,70,84,0.35);">Go to Creator Dashboard</a>
      </td></tr></table>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Creator Application Update</title></head>
<body style="margin:0;padding:0;background:#F0F2F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F2F5;padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.08);">
      <tr><td style="background:linear-gradient(135deg,#1A1A2E 0%,#16213E 100%);padding:32px 40px;text-align:center;">
        <span style="color:#FF4654;font-size:28px;font-weight:900;letter-spacing:-0.5px;">XstreamVideos</span>
        <p style="margin:8px 0 0;color:#ffffff99;font-size:13px;letter-spacing:0.04em;">CREATOR PLATFORM</p>
      </td></tr>
      <tr><td style="padding:32px 40px 0;text-align:center;">
        <div style="font-size:48px;margin-bottom:16px;">${statusConfig.emoji}</div>
        <span style="display:inline-block;background:${statusConfig.color}20;color:${statusConfig.color};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:6px 16px;border-radius:100px;border:1px solid ${statusConfig.color}40;">${statusConfig.badge}</span>
      </td></tr>
      <tr><td style="padding:24px 40px 32px;">
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:800;color:#1A1A2E;text-align:center;">${statusConfig.heading}</h1>
        <p style="margin:16px 0;font-size:15px;color:#374151;line-height:1.7;">Hi <strong>${safeName}</strong>,</p>
        <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.7;">${statusConfig.message}</p>
        ${missingFieldsHtml}
        ${safeReason ? `<div style="background:#F9FAFB;border-left:4px solid ${statusConfig.color};border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:24px;">
          <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Admin Note</p>
          <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;">${safeReason}</p>
        </div>` : ''}
        ${updateLinkHtml}
        ${dashboardHtml}
      </td></tr>
      <tr><td style="background:#F9FAFB;padding:20px 40px;text-align:center;border-top:1px solid #E5E7EB;">
        <p style="margin:0 0 4px;font-size:12px;color:#9CA3AF;">&copy; ${new Date().getFullYear()} XstreamVideos. All rights reserved.</p>
        <p style="margin:0;font-size:12px;color:#9CA3AF;">Questions? <a href="mailto:support@xstreamvideos.site" style="color:#FF4654;">support@xstreamvideos.site</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const subjectMap = {
    approved: '🎉 You\'re a creator on XstreamVideos! Application approved',
    rejected: 'Update on your XstreamVideos creator application',
    info_requested: 'Action required: Additional info needed for your XstreamVideos application',
  };
  const { data, error } = await resend.emails.send({ from, to, subject: subjectMap[status] || 'Update on your creator application', html });
  if (error) console.error(`[email] ✗ Decision email failed: ${error.message}`);
  else console.log(`[email] ✓ Decision email sent to ${to} (${status})`);
}

function getFrom() {
  return process.env.RESEND_FROM_EMAIL || 'XstreamVideos <support@xstreamvideos.site>';
}

// ── Payout email helpers ──────────────────────────────────────────────────────

function payoutEmailShell({ title, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title></head>
<body style="margin:0;padding:0;background:#F0F2F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F2F5;padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.08);">
      <tr><td style="background:linear-gradient(135deg,#1A1A2E 0%,#16213E 100%);padding:32px 40px;text-align:center;">
        <span style="color:#FF4654;font-size:24px;font-weight:900;letter-spacing:-0.5px;">XstreamVideos</span>
        <p style="margin:6px 0 0;color:#ffffff99;font-size:12px;letter-spacing:0.05em;">CREATOR PAYOUTS</p>
      </td></tr>
      ${bodyHtml}
      <tr><td style="background:#F9FAFB;padding:20px 40px;text-align:center;border-top:1px solid #E5E7EB;">
        <p style="margin:0 0 4px;font-size:12px;color:#9CA3AF;">&copy; ${new Date().getFullYear()} XstreamVideos. All rights reserved.</p>
        <p style="margin:0;font-size:12px;color:#9CA3AF;">Questions? <a href="mailto:support@xstreamvideos.site" style="color:#FF4654;">support@xstreamvideos.site</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function bankRow(label, value) {
  const safe = String(value || '—').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  return `<tr>
    <td style="padding:6px 0;font-size:13px;color:#6B7280;width:45%;">${label}</td>
    <td style="padding:6px 0;font-size:13px;color:#1A1A2E;font-weight:600;">${safe}</td>
  </tr>`;
}

export async function sendPayoutRequestedEmail({ to, name, amountUsd, amountNgn, bankName, accountNumber, accountName, referenceId }) {
  const resend = getResend();
  if (!resend) return;
  const from = getFrom();
  const esc = s => String(s || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const safeName = esc(name);
  const usdStr = `$${Number(amountUsd || 0).toFixed(2)}`;
  const ngnStr = amountNgn ? `₦${Number(amountNgn).toLocaleString('en-NG', { minimumFractionDigits: 2 })}` : '';

  const html = payoutEmailShell({ title: 'Withdrawal Request Received', bodyHtml: `
    <tr><td style="padding:32px 40px 0;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">💸</div>
      <span style="display:inline-block;background:#EFF6FF;color:#3B82F6;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:5px 14px;border-radius:100px;">Withdrawal Requested</span>
    </td></tr>
    <tr><td style="padding:24px 40px 32px;">
      <h1 style="margin:0 0 8px;font-size:20px;font-weight:800;color:#1A1A2E;text-align:center;">We've received your withdrawal request</h1>
      <p style="margin:16px 0;font-size:15px;color:#374151;line-height:1.7;">Hi <strong>${safeName}</strong>,</p>
      <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.7;">Your withdrawal request of <strong>${usdStr}${ngnStr ? ` (${ngnStr})` : ''}</strong> has been submitted and is now under review. Our team typically processes requests within 1–3 business days.</p>
      <div style="background:#F9FAFB;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
        <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Withdrawal Details</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${bankRow('Amount (USD)', usdStr)}
          ${ngnStr ? bankRow('Amount (NGN)', ngnStr) : ''}
          ${bankRow('Bank', bankName)}
          ${bankRow('Account Number', accountNumber)}
          ${bankRow('Account Name', accountName)}
          ${referenceId ? bankRow('Reference', referenceId) : ''}
        </table>
      </div>
      <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.6;">You will receive another email once your withdrawal has been processed. If you have any questions, please contact our support team.</p>
    </td></tr>
  ` });

  const { error } = await resend.emails.send({ from, to, subject: `Withdrawal request received — ${usdStr}`, html });
  if (error) console.error(`[email] ✗ Payout requested email failed: ${error.message}`);
  else console.log(`[email] ✓ Payout requested email sent to ${to}`);
}

export async function sendPayoutApprovedEmail({ to, name, amountUsd, amountNgn, bankName, accountNumber, accountName, referenceId }) {
  const resend = getResend();
  if (!resend) return;
  const from = getFrom();
  const esc = s => String(s || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const safeName = esc(name);
  const usdStr = `$${Number(amountUsd || 0).toFixed(2)}`;
  const ngnStr = amountNgn ? `₦${Number(amountNgn).toLocaleString('en-NG', { minimumFractionDigits: 2 })}` : '';

  const html = payoutEmailShell({ title: 'Withdrawal Approved', bodyHtml: `
    <tr><td style="padding:32px 40px 0;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">✅</div>
      <span style="display:inline-block;background:#ECFDF5;color:#10B981;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:5px 14px;border-radius:100px;">Approved — Processing</span>
    </td></tr>
    <tr><td style="padding:24px 40px 32px;">
      <h1 style="margin:0 0 8px;font-size:20px;font-weight:800;color:#1A1A2E;text-align:center;">Your withdrawal has been approved!</h1>
      <p style="margin:16px 0;font-size:15px;color:#374151;line-height:1.7;">Hi <strong>${safeName}</strong>,</p>
      <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.7;">Great news! Your withdrawal of <strong>${usdStr}${ngnStr ? ` (${ngnStr})` : ''}</strong> has been approved and is now being processed. Funds will be sent to your bank account shortly.</p>
      <div style="background:#F9FAFB;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
        <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Payout Details</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${bankRow('Amount (USD)', usdStr)}
          ${ngnStr ? bankRow('Amount (NGN)', ngnStr) : ''}
          ${bankRow('Bank', bankName)}
          ${bankRow('Account Number', accountNumber)}
          ${bankRow('Account Name', accountName)}
          ${referenceId ? bankRow('Reference', referenceId) : ''}
        </table>
      </div>
      <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.6;">Bank transfers typically take 1–2 business days to reflect in your account. You'll receive a final confirmation once payment is complete.</p>
    </td></tr>
  ` });

  const { error } = await resend.emails.send({ from, to, subject: `Withdrawal approved — ${usdStr} processing now`, html });
  if (error) console.error(`[email] ✗ Payout approved email failed: ${error.message}`);
  else console.log(`[email] ✓ Payout approved email sent to ${to}`);
}

export async function sendPayoutPaidEmail({ to, name, amountUsd, amountNgn, bankName, accountNumber, accountName, referenceId }) {
  const resend = getResend();
  if (!resend) return;
  const from = getFrom();
  const esc = s => String(s || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const safeName = esc(name);
  const usdStr = `$${Number(amountUsd || 0).toFixed(2)}`;
  const ngnStr = amountNgn ? `₦${Number(amountNgn).toLocaleString('en-NG', { minimumFractionDigits: 2 })}` : '';

  const html = payoutEmailShell({ title: 'Payment Sent!', bodyHtml: `
    <tr><td style="padding:32px 40px 0;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">🎉</div>
      <span style="display:inline-block;background:#ECFDF5;color:#10B981;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:5px 14px;border-radius:100px;">Payment Sent</span>
    </td></tr>
    <tr><td style="padding:24px 40px 32px;">
      <h1 style="margin:0 0 8px;font-size:20px;font-weight:800;color:#1A1A2E;text-align:center;">Your payment has been sent! 🎊</h1>
      <p style="margin:16px 0;font-size:15px;color:#374151;line-height:1.7;">Hi <strong>${safeName}</strong>,</p>
      <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.7;">Your withdrawal of <strong>${usdStr}${ngnStr ? ` (${ngnStr})` : ''}</strong> has been sent to your bank account. Please allow 1–2 business days for the funds to appear.</p>
      <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
        <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:0.05em;">Payment Confirmation</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${bankRow('Amount Paid (USD)', usdStr)}
          ${ngnStr ? bankRow('Amount Paid (NGN)', ngnStr) : ''}
          ${bankRow('Bank', bankName)}
          ${bankRow('Account Number', accountNumber)}
          ${bankRow('Account Name', accountName)}
          ${referenceId ? bankRow('Reference', referenceId) : ''}
        </table>
      </div>
      <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.6;">If the funds don't arrive within 3 business days, please contact our support team with the reference above.</p>
    </td></tr>
  ` });

  const { error } = await resend.emails.send({ from, to, subject: `Payment sent — ${usdStr} on its way to your bank`, html });
  if (error) console.error(`[email] ✗ Payout paid email failed: ${error.message}`);
  else console.log(`[email] ✓ Payout paid email sent to ${to}`);
}

export async function sendPayoutRejectedEmail({ to, name, amountUsd, reason }) {
  const resend = getResend();
  if (!resend) return;
  const from = getFrom();
  const esc = s => String(s || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const safeName = esc(name);
  const safeReason = esc(reason || 'No reason provided.');
  const usdStr = `$${Number(amountUsd || 0).toFixed(2)}`;

  const html = payoutEmailShell({ title: 'Withdrawal Request Declined', bodyHtml: `
    <tr><td style="padding:32px 40px 0;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">❌</div>
      <span style="display:inline-block;background:#FEF2F2;color:#EF4444;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:5px 14px;border-radius:100px;">Withdrawal Declined</span>
    </td></tr>
    <tr><td style="padding:24px 40px 32px;">
      <h1 style="margin:0 0 8px;font-size:20px;font-weight:800;color:#1A1A2E;text-align:center;">Your withdrawal request was declined</h1>
      <p style="margin:16px 0;font-size:15px;color:#374151;line-height:1.7;">Hi <strong>${safeName}</strong>,</p>
      <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.7;">We were unable to process your withdrawal request of <strong>${usdStr}</strong>. The funds have been returned to your creator balance.</p>
      <div style="background:#FEF2F2;border-left:4px solid #EF4444;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:24px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#991B1B;text-transform:uppercase;letter-spacing:0.05em;">Reason</p>
        <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;">${safeReason}</p>
      </div>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;">You can submit a new withdrawal request from your creator dashboard. If you believe this was an error, please contact our support team.</p>
      <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:8px;">
        <a href="${process.env.FRONTEND_URL || 'https://xstreamvideos.site'}/studio" style="display:inline-block;background:linear-gradient(135deg,#FF4654 0%,#FF7043 100%);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:10px;box-shadow:0 4px 12px rgba(255,70,84,0.35);">Go to Creator Studio</a>
      </td></tr></table>
    </td></tr>
  ` });

  const { error } = await resend.emails.send({ from, to, subject: `Withdrawal request declined — ${usdStr}`, html });
  if (error) console.error(`[email] ✗ Payout rejected email failed: ${error.message}`);
  else console.log(`[email] ✓ Payout rejected email sent to ${to}`);
}

export async function sendOTPEmail(to, otp) {
  const resend = getResend();
  if (!resend) {
    console.error('[email] ✗ Email service not configured — RESEND_API_KEY is missing.');
    throw new Error('Email service not configured — set RESEND_API_KEY in environment.');
  }

  const safeOtp = String(otp).replace(/[<>&"]/g, '');
  const from = getFrom();

  console.log(`[email] → Sending OTP email to: ${to}`);
  const t0 = Date.now();

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: 'Your OTP Code — XstreamVideos',
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Your OTP Code</title></head>
<body style="margin:0;padding:0;background:#F0F2F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F2F5;padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.08);">
      <tr><td style="background:linear-gradient(135deg,#1A1A2E 0%,#16213E 100%);padding:32px 40px;text-align:center;">
        <span style="color:#FF4654;font-size:24px;font-weight:900;letter-spacing:-0.5px;">XstreamVideos</span>
      </td></tr>
      <tr><td style="padding:40px 40px 32px;text-align:center;">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#1A1A2E;">Your Verification Code</h1>
        <p style="margin:0 0 32px;font-size:15px;color:#6B7280;line-height:1.6;">Use the code below to verify your identity. It expires in <strong>5 minutes</strong>.</p>
        <div style="display:inline-block;background:#F3F4F6;border-radius:12px;padding:20px 40px;margin-bottom:32px;">
          <span style="font-size:40px;font-weight:900;letter-spacing:8px;color:#1A1A2E;">${safeOtp}</span>
        </div>
        <p style="margin:0;font-size:13px;color:#9CA3AF;">If you didn't request this code, you can safely ignore this email.</p>
      </td></tr>
      <tr><td style="background:#F9FAFB;padding:20px 40px;text-align:center;border-top:1px solid #E5E7EB;">
        <p style="margin:0;font-size:12px;color:#9CA3AF;">&copy; ${new Date().getFullYear()} XstreamVideos. All rights reserved.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`,
  });

  if (error) {
    console.error(`[email] ✗ OTP email failed for ${to} — ${error.message}`);
    throw new Error(`Resend error: ${error.message}`);
  }

  console.log(`[email] ✓ OTP email sent to ${to} (id: ${data?.id ?? 'n/a'}, ${Date.now() - t0}ms)`);
}

export async function sendAdminEmail(to, subject, message) {
  const resend = getResend();
  if (!resend) {
    console.error('[email] ✗ Email service not configured — RESEND_API_KEY is missing.');
    throw new Error('Email service not configured — set RESEND_API_KEY in environment.');
  }

  const safeMessage = String(message || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const from = getFrom();

  console.log(`[email] → Sending admin email to: ${to} | subject: ${subject}`);
  const t0 = Date.now();

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#F0F2F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F2F5;padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.08);">
      <tr><td style="background:linear-gradient(135deg,#1A1A2E 0%,#16213E 100%);padding:32px 40px;text-align:center;">
        <span style="color:#FF4654;font-size:24px;font-weight:900;letter-spacing:-0.5px;">XstreamVideos</span>
      </td></tr>
      <tr><td style="padding:40px 40px 32px;">
        <h1 style="margin:0 0 24px;font-size:20px;font-weight:800;color:#1A1A2E;">Message from XstreamVideos</h1>
        <div style="font-size:15px;color:#374151;line-height:1.7;">${safeMessage}</div>
      </td></tr>
      <tr><td style="background:#F9FAFB;padding:20px 40px;text-align:center;border-top:1px solid #E5E7EB;">
        <p style="margin:0;font-size:12px;color:#9CA3AF;">&copy; ${new Date().getFullYear()} XstreamVideos. All rights reserved.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`,
  });

  if (error) {
    console.error(`[email] ✗ Admin email failed for ${to} — ${error.message}`);
    throw new Error(`Resend error: ${error.message}`);
  }

  console.log(`[email] ✓ Admin email sent to ${to} (id: ${data?.id ?? 'n/a'}, ${Date.now() - t0}ms)`);
}
