/**
 * run-migration.mjs
 *
 * Applies the membership migration to your Supabase Postgres database.
 *
 * Usage:
 *   node scripts/run-migration.mjs
 *
 * Requires DATABASE_URL in backend/.env  OR set it inline:
 *   DATABASE_URL="postgresql://postgres:[PASSWORD]@db.klsyhrenzgumzxwvbdft.supabase.co:5432/postgres" \
 *     node scripts/run-migration.mjs
 *
 * Get DATABASE_URL from:
 *   Supabase Dashboard → Settings → Database → Connection string → URI
 *   Replace [YOUR-PASSWORD] with your database password.
 */

import { createRequire } from 'module';
import { readFileSync }  from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// Load .env from backend root
try {
  const { config } = await import('dotenv');
  config({ path: resolve(__dirname, '../.env') });
} catch {
  // dotenv optional
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(`
ERROR: DATABASE_URL not set.

Get it from: Supabase Dashboard → Settings → Database → Connection string (URI)
It looks like:
  postgresql://postgres:[YOUR-PASSWORD]@db.klsyhrenzgumzxwvbdft.supabase.co:5432/postgres

Then either:
  1. Add to backend/.env:  DATABASE_URL=postgresql://...
  2. Or prefix the command:
       DATABASE_URL="postgresql://postgres:PASSWORD@db.klsyhrenzgumzxwvbdft.supabase.co:5432/postgres" node scripts/run-migration.mjs
`);
  process.exit(1);
}

const { default: pg } = await import('pg');
const { Client } = pg;

const sql = readFileSync(
  resolve(__dirname, '../supabase/migrations/20250413_membership.sql'),
  'utf8'
);

const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

try {
  console.log('Connecting to database…');
  await client.connect();
  console.log('Connected. Running migration…\n');

  await client.query(sql);

  console.log('Migration applied successfully.\n');
  console.log('Tables created:');
  console.log('  ✓ public.membership_plans');
  console.log('  ✓ public.user_memberships');
  console.log('  ✓ public.users  (coin_balance, active_plan, plan_expires_at, plan_grace_ends_at columns added)');
  console.log('Functions created:');
  console.log('  ✓ public.add_coins(text, integer)');
  console.log('  ✓ public.spend_coins(text, integer)');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
