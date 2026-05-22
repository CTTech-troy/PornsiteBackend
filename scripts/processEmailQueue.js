import 'dotenv/config';
import { supabase } from '../src/config/supabase.js';
import { getResend, getFrom } from '../src/services/emailService.js';

const BATCH = 25;

async function processBatch() {
  if (!supabase) {
    console.error('Supabase not configured.');
    process.exit(1);
  }

  const resend = getResend();
  if (!resend) {
    console.error('RESEND_API_KEY not configured.');
    process.exit(1);
  }

  const { data: rows, error } = await supabase
    .from('finance_email_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(BATCH);

  if (error) {
    console.error(error.message);
    process.exit(1);
  }

  let sent = 0;
  for (const row of rows || []) {
    const { error: sendError } = await resend.emails.send({
      from: getFrom(),
      to: row.to_email,
      subject: row.subject,
      html: row.html_body,
    });

    if (sendError) {
      await supabase.from('finance_email_queue').update({
        status: 'failed',
        retry_count: (row.retry_count || 0) + 1,
        last_error: sendError.message,
      }).eq('id', row.id);
      continue;
    }

    await supabase.from('finance_email_queue').update({
      status: 'sent',
      sent_at: new Date().toISOString(),
    }).eq('id', row.id);
    sent += 1;
  }

  console.log(`Processed ${sent}/${(rows || []).length} queued emails.`);
}

processBatch().catch((err) => {
  console.error(err);
  process.exit(1);
});
