import dotenv from 'dotenv';

dotenv.config();

const from = process.env.SENDGRID_FROM || process.env.SMTP_FROM || `no-reply@${process.env.SMTP_DOMAIN || 'example.com'}`;

async function sendVerificationEmail(to, verificationLink, name) {
  const html = `\n<p>Hi ${name || ''},</p>\n<p>Please confirm your email:</p>\n<p>${verificationLink}</p>\n`;
  console.log('--- VERIFICATION EMAIL (LOG ONLY) ---');
  console.log(`To: ${to}`);
  console.log(`From: ${from}`);
  console.log('Subject: Confirm your letstream account');
  console.log('HTML:\n', html);
  console.log('--- END VERIFICATION EMAIL ---');
  return { ok: true, logged: true };
}

export { sendVerificationEmail };
