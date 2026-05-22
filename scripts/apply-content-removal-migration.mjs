/**
 * Applies content_removal_requests migration to Supabase Postgres.
 * Requires DATABASE_URL or SUPABASE_DB_PASSWORD in backend/.env
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const UPGRADE_FILE = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260520170100_content_removal_legacy_upgrade.sql',
);
const BASE_FILE = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260520170000_content_removal_applications.sql',
);

const VERIFY_SQL = `
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'content_removal_requests'
ORDER BY ordinal_position;
`;

const REQUIRED_COLUMNS = new Set([
  'request_id',
  'submitted_at',
  'relationship_to_content',
  'notes',
  'activity',
]);

function resolveDatabaseUrl() {
  const direct =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    '';
  if (direct) return direct.trim();

  const password = (process.env.SUPABASE_DB_PASSWORD || '').trim();
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  if (!password || !supabaseUrl) return '';

  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  const encoded = encodeURIComponent(password);
  return `postgresql://postgres:${encoded}@db.${ref}.supabase.co:5432/postgres`;
}

async function checkViaSupabaseApi() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return { configured: false, exists: false };

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false } });
  const { error } = await supabase.from('content_removal_requests').select('request_id, submitted_at').limit(1);
  if (!error) return { configured: true, exists: true, columnsOk: true };
  if (error.code === '42P01' || /does not exist|schema cache/i.test(error.message || '')) {
    return { configured: true, exists: false };
  }
  if (error.code === '42703') {
    return { configured: true, exists: true, columnsOk: false, legacy: true, message: error.message };
  }
  return { configured: true, exists: null, message: error.message };
}

async function applyViaPg(connectionString, { legacy = false } = {}) {
  const migrationFile = legacy ? UPGRADE_FILE : BASE_FILE;
  const sql = fs.readFileSync(migrationFile, 'utf8');
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
    await client.query("NOTIFY pgrst, 'reload schema';");
    const { rows } = await client.query(VERIFY_SQL);
    return rows;
  } finally {
    await client.end();
  }
}

function validateColumns(rows) {
  const names = new Set(rows.map((r) => r.column_name));
  const missing = [...REQUIRED_COLUMNS].filter((c) => !names.has(c));
  return { ok: missing.length === 0, missing, count: rows.length };
}

async function main() {
  const dbUrl = resolveDatabaseUrl();

  console.log('[content-removal] Checking current state…');
  const apiState = await checkViaSupabaseApi();
  if (apiState.exists && apiState.columnsOk) {
    console.log('[content-removal] Table already exists with the correct schema.');
    return;
  }

  const legacy = apiState.legacy === true;

  if (!dbUrl) {
    console.error('[content-removal] Cannot apply migration without a Postgres connection.');
    console.error('');
    console.error('Add one of these to backend/.env, then re-run:');
    console.error('  DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres');
    console.error('  SUPABASE_DB_PASSWORD=your_database_password');
    console.error('');
    console.error('Or paste this file in Supabase Dashboard → SQL Editor:');
    console.error(`  ${legacy ? UPGRADE_FILE : BASE_FILE}`);
    process.exit(1);
  }

  if (legacy) {
    console.log('[content-removal] Legacy schema detected — applying upgrade migration…');
  } else {
    console.log('[content-removal] Applying migration via Postgres…');
  }
  const rows = await applyViaPg(dbUrl, { legacy });
  const validation = validateColumns(rows);
  if (!validation.ok) {
    console.error('[content-removal] Migration ran but required columns are missing:', validation.missing.join(', '));
    process.exit(1);
  }
  console.log(`[content-removal] Success. ${validation.count} columns on public.content_removal_requests.`);
  console.log('[content-removal] PostgREST schema reload notified.');
}

main().catch((err) => {
  console.error('[content-removal] Failed:', err.message || err);
  process.exit(1);
});
