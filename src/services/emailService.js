import { Resend } from 'resend';

let resendClient = null;

export function getResend() {
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
                This link will expire in <strong>24 hours</strong>. If you did not create this account, you can safely ignore this email.
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

export async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const resend = getResend();
  if (!resend) {
    console.error('[email] ✗ Email service not configured — RESEND_API_KEY is missing.');
    throw new Error('Email service not configured — set RESEND_API_KEY in environment.');
  }
  const safeName = String(name || 'there').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const safeUrl = String(resetUrl || '#').replace(/"/g, '%22');
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Reset your password</title></head>
<body style="margin:0;padding:0;background:#F0F2F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F2F5;padding:40px 16px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(26,26,46,0.08);">
<tr><td style="background:linear-gradient(135deg,#1A1A2E 0%,#16213E 100%);padding:32px 40px;text-align:center;">
<span style="color:#FF4654;font-size:24px;font-weight:900;">Xstream</span></td></tr>
<tr><td style="padding:40px 40px 32px;">
<h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#1A1A2E;">Reset your password</h1>
<p style="margin:0 0 24px;font-size:15px;color:#6B7280;">Hi ${safeName}, we received a request to reset your password.</p>
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:24px;">
<a href="${safeUrl}" style="display:inline-block;background:linear-gradient(135deg,#FF4654 0%,#FF7043 100%);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:10px;">Choose a new password</a>
</td></tr></table>
<p style="margin:0;font-size:12px;color:#9CA3AF;">If you did not request this, you can ignore this email.</p>
<p style="margin:16px 0 0;font-size:12px;color:#FF4654;word-break:break-all;"><a href="${safeUrl}" style="color:#FF4654;">${safeUrl}</a></p>
</td></tr>
<tr><td style="background:#F9FAFB;padding:20px 40px;text-align:center;border-top:1px solid #E5E7EB;">
<p style="margin:0;font-size:12px;color:#9CA3AF;">&copy; ${new Date().getFullYear()} Xstream</p>
</td></tr></table></td></tr></table></body></html>`;
  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: 'Reset your Xstream password',
    html,
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[email] ✓ Password reset email sent to ${to} (id: ${data?.id ?? 'n/a'})`);
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
  const isSubmitted = status === 'submitted';
  const isReapplied = status === 'reapplied';

  const statusConfig = isApproved
    ? { emoji: '🎉', heading: 'Congratulations! Your application has been approved.', color: '#10B981', badge: 'Approved',
        message: 'Welcome to the XstreamVideos creator family! You can now start creating and monetizing your content. Head to your dashboard to set up your creator profile and begin streaming.' }
    : isRejected
    ? { emoji: '😔', heading: 'Your creator application was not approved.', color: '#EF4444', badge: 'Not Approved',
        message: 'We appreciate your interest in joining XstreamVideos as a creator. Unfortunately, your application did not meet our current requirements. You are welcome to reapply in the future.' }
    : isInfoRequest
    ? { emoji: '📋', heading: 'Additional information required for your application.', color: '#F59E0B', badge: 'Info Requested',
        message: 'Thank you for applying to become a creator on XstreamVideos! We need a bit more information before we can process your application. Please use the link below to provide the missing details.' }
    : isSubmitted
    ? { emoji: '📝', heading: 'Your creator application has been submitted.', color: '#3B82F6', badge: 'Submitted',
        message: 'Thank you for applying to become a creator on XstreamVideos! Your application is now under review. We will notify you once a decision has been made.' }
    : isReapplied
    ? { emoji: '🔄', heading: 'Your reapplication has been submitted.', color: '#8B5CF6', badge: 'Reapplied',
        message: 'Thank you for reapplying to become a creator on XstreamVideos! Your new application is now under review. We will notify you once a decision has been made.' }
    : { emoji: '❓', heading: 'Application status update.', color: '#6B7280', badge: 'Update',
        message: 'There has been an update to your creator application status.' };

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
    submitted: '📝 Your creator application has been submitted',
    reapplied: '🔄 Your reapplication has been submitted',
  };
  const { data, error } = await resend.emails.send({ from, to, subject: subjectMap[status] || 'Update on your creator application', html });
  if (error) console.error(`[email] ✗ Decision email failed: ${error.message}`);
  else console.log(`[email] ✓ Decision email sent to ${to} (${status})`);
}

export async function sendAccountDeletionEmail({ to, name, reason, platformUrl = 'https://xstreamvideos.site' }) {
  const resend = getResend();
  if (!resend) {
    throw new Error('Email service not configured - set RESEND_API_KEY in environment.');
  }

  const esc = (s) => String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const safeName = esc(name || 'there');
  const safeReason = esc(reason || 'No reason was provided.');
  let publicUrl = 'https://xstreamvideos.site';
  try {
    const parsedUrl = new URL(platformUrl || publicUrl);
    if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') {
      publicUrl = parsedUrl.toString();
    }
  } catch (_) {}
  const safePlatformUrl = esc(publicUrl);
  const supportEmail = process.env.SUPPORT_EMAIL || 'support@xstreamvideos.site';
  const safeSupportEmail = esc(supportEmail);
  const from = getFrom();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Your XStreamVideos Account Has Been Deleted</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f3f4f6;padding:36px 14px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 18px 45px rgba(17,24,39,0.10);">
        <tr><td style="background:#111827;padding:30px 36px;text-align:center;">
          <div style="font-size:26px;line-height:1;font-weight:900;letter-spacing:-0.4px;color:#ffffff;">XStream<span style="color:#ff4654;">Videos</span></div>
          <div style="margin-top:8px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#d1d5db;">Account notice</div>
        </td></tr>
        <tr><td style="padding:34px 36px 10px;">
          <h1 style="margin:0 0 12px;font-size:23px;line-height:1.25;font-weight:800;color:#111827;">Your account has been deleted</h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#4b5563;">Hi ${safeName},</p>
          <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:#4b5563;">Your account has been removed from XStreamVideos by an administrator.</p>
          <div style="margin:0 0 24px;border:1px solid #fee2e2;border-left:4px solid #ff4654;background:#fff7f7;border-radius:12px;padding:16px 18px;">
            <div style="font-size:12px;line-height:1.4;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#991b1b;">Reason provided</div>
            <p style="margin:8px 0 0;font-size:14px;line-height:1.65;color:#374151;">${safeReason}</p>
          </div>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#4b5563;">You are welcome to create a new account at XStreamVideos.</p>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="padding:0 0 24px;">
            <a href="${safePlatformUrl}" style="display:inline-block;background:#ff4654;color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;padding:14px 28px;border-radius:10px;box-shadow:0 10px 24px rgba(255,70,84,0.28);">Create a new account</a>
          </td></tr></table>
          <p style="margin:0 0 4px;font-size:13px;line-height:1.7;color:#6b7280;text-align:center;">Button not working? Open this link:</p>
          <p style="margin:0 0 24px;font-size:13px;line-height:1.7;text-align:center;word-break:break-all;"><a href="${safePlatformUrl}" style="color:#ff4654;text-decoration:none;">${safePlatformUrl}</a></p>
        </td></tr>
        <tr><td style="padding:0 36px 32px;">
          <div style="border-top:1px solid #e5e7eb;padding-top:20px;">
            <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#4b5563;font-weight:700;">Need help?</p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">Contact support at <a href="mailto:${safeSupportEmail}" style="color:#ff4654;text-decoration:none;">${safeSupportEmail}</a>.</p>
          </div>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:20px 36px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">&copy; ${new Date().getFullYear()} XStreamVideos. Thank you.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: 'Your XStreamVideos Account Has Been Deleted',
    html,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[email] Account deletion email sent to ${to} (id: ${data?.id ?? 'n/a'})`);
  return { id: data?.id || null };
}

export function getFrom() {
  return process.env.RESEND_FROM_EMAIL || 'XstreamVideos <support@xstreamvideos.site>';
}

function emailEsc(value) {
  return String(value ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function contentRemovalEmailShell({ title, eyebrow = 'TRUST & SAFETY', bodyHtml }) {
  const year = new Date().getFullYear();
  const supportEmail = emailEsc(process.env.SUPPORT_EMAIL || 'support@xstreamvideos.site');
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${emailEsc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f6fb;padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 16px 40px rgba(15,23,42,0.10);">
      <tr>
        <td style="background:#111113;padding:30px 34px;">
          <div style="color:#FF4654;font-size:23px;font-weight:900;letter-spacing:-0.4px;">XStreamVideos</div>
          <div style="margin-top:8px;color:#ffffff99;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">${emailEsc(eyebrow)}</div>
        </td>
      </tr>
      <tr><td style="padding:34px;">
        ${bodyHtml}
      </td></tr>
      <tr>
        <td style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:22px 34px;">
          <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#64748b;">Need help? Contact <a href="mailto:${supportEmail}" style="color:#FF4654;text-decoration:none;">${supportEmail}</a>.</p>
          <p style="margin:0;font-size:12px;color:#94a3b8;">&copy; ${year} XStreamVideos. All rights reserved.</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendContentRemovalMail({ to, subject, html, required = false }) {
  const resend = getResend();
  if (!resend) {
    if (required) throw new Error('Email service not configured - set RESEND_API_KEY in environment.');
    console.warn('[email] content removal email skipped: RESEND_API_KEY is missing.');
    return null;
  }
  const { data, error } = await resend.emails.send({ from: getFrom(), to, subject, html });
  if (error) throw new Error(`Resend error: ${error.message}`);
  return { id: data?.id || null };
}

export async function sendContentRemovalConfirmationEmail({ to, name, requestId, contentUrl, deadlineAt }) {
  const safeName = emailEsc(name || 'there');
  const safeRequestId = emailEsc(requestId);
  const safeUrl = emailEsc(contentUrl);
  const deadline = deadlineAt ? new Date(deadlineAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'within 2 weeks';
  const html = contentRemovalEmailShell({
    title: 'Content removal request received',
    bodyHtml: `
      <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#111827;">Your request has been received</h1>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#374151;">Hi ${safeName},</p>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#374151;">We received your content removal application. It is now visible to our admin team, and the review process has started.</p>
      <div style="margin:24px 0;padding:18px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
        <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Request ID</p>
        <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;font-weight:800;color:#111827;">${safeRequestId}</p>
        <p style="margin:16px 0 8px;font-size:13px;color:#64748b;">Content URL</p>
        <p style="margin:0;font-size:13px;line-height:1.5;color:#111827;word-break:break-all;">${safeUrl}</p>
      </div>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#374151;">Our Trust & Safety team aims to complete the review within <strong>2 weeks</strong>. Current target decision date: <strong>${emailEsc(deadline)}</strong>.</p>
      <p style="margin:0;font-size:13px;line-height:1.7;color:#64748b;">Please keep your Request ID for future correspondence. We may contact you if we need additional evidence or clarification.</p>
    `,
  });
  return sendContentRemovalMail({
    to,
    subject: `Content removal request received - ${requestId}`,
    html,
  });
}

export async function sendContentRemovalStatusEmail({ to, name, requestId, status, statusLabel, message, deadlineAt }) {
  const copy = {
    under_review: {
      subject: 'Your content removal request is under review',
      title: 'Review has started',
      body: 'An admin has started reviewing your content removal request.',
    },
    approved: {
      subject: 'Your content removal request was approved',
      title: 'Request approved',
      body: 'Your content removal request was granted. Our team will complete the required content action and document the outcome.',
    },
    rejected: {
      subject: 'Your content removal request was not approved',
      title: 'Request not approved',
      body: 'After review, your content removal request was denied based on the information provided and our platform policies.',
    },
    needs_info: {
      subject: 'More information is needed for your content removal request',
      title: 'Additional information required',
      body: 'We need more proof or clarification before we can complete the review.',
    },
  }[status] || {
    subject: 'Your content removal request was updated',
    title: 'Request updated',
    body: 'Your content removal request has a new update.',
  };

  const safeMessage = emailEsc(message || 'No additional admin message was provided.');
  const deadline = deadlineAt ? new Date(deadlineAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'within 2 weeks';
  const html = contentRemovalEmailShell({
    title: copy.title,
    bodyHtml: `
      <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#111827;">${emailEsc(copy.title)}</h1>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#374151;">Hi ${emailEsc(name || 'there')},</p>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#374151;">${emailEsc(copy.body)}</p>
      <div style="margin:24px 0;padding:18px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
        <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Request ID</p>
        <p style="margin:0 0 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;font-weight:800;color:#111827;">${emailEsc(requestId)}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Current status</p>
        <p style="margin:0;font-size:15px;font-weight:800;color:#111827;">${emailEsc(statusLabel || status)}</p>
      </div>
      <div style="margin:24px 0;padding:18px;border-left:4px solid #FF4654;border-radius:12px;background:#fff5f6;">
        <p style="margin:0 0 8px;font-size:13px;font-weight:800;color:#991b1b;">Admin message</p>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#374151;white-space:pre-wrap;">${safeMessage}</p>
      </div>
      <p style="margin:0;font-size:13px;line-height:1.7;color:#64748b;">Policy reference: Terms of Service, Privacy Policy, Content Removal Policy, and Community Guidelines. Target decision timeline remains ${emailEsc(deadline)} unless additional information is required.</p>
    `,
  });
  return sendContentRemovalMail({
    to,
    subject: `${copy.subject} - ${requestId}`,
    html,
  });
}

export async function sendContentRemovalFeedbackEmail({ to, name, requestId, message }) {
  const html = contentRemovalEmailShell({
    title: 'Message about your content removal request',
    bodyHtml: `
      <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#111827;">Admin feedback</h1>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#374151;">Hi ${emailEsc(name || 'there')},</p>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#374151;">Our Trust & Safety team sent a message about your content removal request.</p>
      <div style="margin:24px 0;padding:18px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
        <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Request ID</p>
        <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;font-weight:800;color:#111827;">${emailEsc(requestId)}</p>
      </div>
      <div style="margin:24px 0;padding:18px;border-left:4px solid #FF4654;border-radius:12px;background:#fff5f6;">
        <p style="margin:0;font-size:14px;line-height:1.7;color:#374151;white-space:pre-wrap;">${emailEsc(message)}</p>
      </div>
    `,
  });
  return sendContentRemovalMail({
    to,
    subject: `Message about your content removal request - ${requestId}`,
    html,
    required: true,
  });
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

export async function sendPremiumVideoPurchaseEmails({
  creatorEmail,
  creatorName,
  buyerName,
  videoTitle,
  purchaseAmountUsd,
  creatorEarningsUsd,
  platformEarningsUsd,
  purchasedAt,
}) {
  const resend = getResend();
  const from = getFrom();
  const title = String(videoTitle || 'Premium video').replace(/[<>&"]/g, '');
  const buyer = String(buyerName || 'A user').replace(/[<>&"]/g, '');
  const earnings = Number(creatorEarningsUsd || 0).toFixed(2);
  const total = Number(purchaseAmountUsd || 0).toFixed(2);
  const platform = Number(platformEarningsUsd || 0).toFixed(2);
  const when = purchasedAt ? new Date(purchasedAt).toLocaleString() : new Date().toLocaleString();

  if (creatorEmail && resend) {
    const subject = `You earned $${earnings} — premium sale`;
    const html = `<p>Hi ${creatorName || 'Creator'},</p>
<p><strong>${buyer}</strong> purchased your premium video <strong>"${title}"</strong>.</p>
<p>You earned <strong>$${earnings}</strong> (sale total $${total}).</p>
<p>Purchase time: ${when}</p>
<p><a href="${process.env.FRONTEND_URL || 'https://xstreamvideos.site'}/studio">Open Creator Studio</a></p>`;
    await resend.emails.send({ from, to: creatorEmail, subject, html }).catch(() => {});
  }

  const adminEmail = process.env.ADMIN_FINANCE_EMAIL || process.env.SUPPORT_NOTIFICATIONS_EMAIL;
  if (adminEmail && resend) {
    const subject = `Premium video purchase — $${total}`;
    const html = `<p>Premium video purchased.</p>
<ul>
<li>Buyer: ${buyer}</li>
<li>Video: ${title}</li>
<li>Total: $${total}</li>
<li>Creator earnings: $${earnings}</li>
<li>Platform earnings: $${platform}</li>
<li>Time: ${when}</li>
</ul>`;
    await resend.emails.send({ from, to: adminEmail, subject, html }).catch(() => {});
  }
}
