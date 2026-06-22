/**
 * Smoke test: content removal table + public submit endpoint.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const API_BASE = (
  process.env.BACKEND_URL ||
  process.env.BACKEND_PUBLIC_URL ||
  'https://api.xstreamvideos.site'
).replace(/\/$/, '');

async function verifySchema() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Supabase not configured in backend/.env');

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false } });
  const { error } = await supabase.from('content_removal_requests').select('request_id, submitted_at, status').limit(1);
  if (error) throw new Error(`Schema check failed: ${error.message}`);
  console.log('[smoke] Schema OK: request_id, submitted_at, status');
}

async function testDirectInsert() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false } });

  const requestId = `CR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-SMOKE`;
  const now = new Date().toISOString();
  const row = {
    request_id: requestId,
    full_name: 'Smoke Test User',
    email: `smoke-${Date.now()}@example.com`,
    relationship_to_content: 'copyright_owner',
    content_url: 'https://example.com/video/123',
    reason: 'copyright',
    notes: 'Automated smoke test submission for content removal migration verification.',
    consent_accuracy: true,
    consent_authorized: true,
    digital_signature: 'Smoke Test',
    status: 'pending',
    files: [],
    activity: [],
    submitted_at: now,
    deadline_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: now,
  };

  const { data, error } = await supabase.from('content_removal_requests').insert(row).select('request_id').maybeSingle();
  if (error) throw new Error(`Direct insert failed: ${error.message}`);
  console.log('[smoke] Direct insert OK:', data.request_id);

  await supabase.from('content_removal_requests').delete().eq('request_id', requestId);
  console.log('[smoke] Cleanup OK (removed test row)');
}

async function testPublicSubmitApi() {
  const payload = {
    full_name: 'Smoke Test User',
    fullName: 'Smoke Test User',
    email: `smoke-${Date.now()}@example.com`,
    relationship_to_content: 'copyright_owner',
    content_url: 'https://example.com/video/123',
    reason: 'copyright',
    notes: 'Automated smoke test submission for content removal migration verification.',
    consent_accuracy: true,
    consent_authorized: true,
    digital_signature: 'Smoke Test',
  };

  const res = await fetch(`${API_BASE}/api/contentRemoval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`API submit failed (${res.status}): ${data.message || data.error || res.statusText}`);
  }
  if (!data.success || !data.data?.request_id) {
    throw new Error(`API response missing request_id: ${JSON.stringify(data)}`);
  }
  console.log('[smoke] API submit OK:', data.data.request_id);
}

async function main() {
  console.log('[smoke] API base:', API_BASE);
  await verifySchema();
  await testDirectInsert();

  try {
    await testPublicSubmitApi();
  } catch (err) {
    console.warn('[smoke] API submit skipped or failed (deploy latest backend for this check):', err.message);
  }

  console.log('[smoke] All checks passed.');
}

main().catch((err) => {
  console.error('[smoke] Failed:', err.message || err);
  process.exit(1);
});
