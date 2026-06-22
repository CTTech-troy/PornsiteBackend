import { getResend, getFrom } from './emailService.js';
import { queueReceiptEmail } from './receiptService.js';
import { getEmailTheme, htmlToText, isValidEmail } from './emailRenderer.js';

export async function sendPayoutReceiptEmail({ to, subject, htmlBody, payoutId, receiptId }) {
  const resend = getResend();
  if (!resend || !to || !isValidEmail(to)) {
    await queueReceiptEmail({ to, subject, htmlBody, payload: { payoutId, receiptId } });
    return { queued: true };
  }

  const from = getFrom();
  const theme = getEmailTheme();
  const { error } = await resend.emails.send({
    from,
    to,
    subject,
    html: htmlBody,
    text: htmlToText(htmlBody),
    replyTo: theme.supportEmail,
    tags: [
      { name: 'template', value: 'payout_receipt' },
      { name: 'category', value: 'Receipts' },
    ],
  });
  if (error) {
    await queueReceiptEmail({ to, subject, htmlBody, payload: { payoutId, receiptId, error: error.message } });
    console.error(`[payout-email] failed: ${error.message}`);
    return { queued: true, error: error.message };
  }
  return { sent: true };
}

export function receiptEmailSubject(type, receiptNumber, amountUsd) {
  const usd = `$${Number(amountUsd || 0).toFixed(2)}`;
  if (type === 'paid') return `Payout receipt ${receiptNumber || 'pending'} - ${usd} paid`;
  return `Withdrawal declined ${receiptNumber || 'pending'} - ${usd}`;
}
