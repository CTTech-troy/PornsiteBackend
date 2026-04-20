/**
 * apply-migration.js
 *
 * Applies the chat_queue migration to the Supabase (Postgres) database.
 *
 * Usage:
 *   node apply-migration.js
 *
 * Requires one of these in backend/.env:
 *   DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
 *   — OR —
 *   SUPABASE_DB_URL=<same format>
 *
 * If neither is set, the script prints the SQL so you can run it manually
 * in the Supabase Dashboard → SQL Editor.
 *
 * Your Supabase database password is at:
 *   Dashboard → Settings → Database → Database password
 * Connection string format:
 *   Dashboard → Settings → Database → Connection string → URI (Session mode, port 5432)
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_FILE = resolve(
  __dirname,
  'supabase/migrations/20250414_chat_queue.sql'
);

const SQL = readFileSync(MIGRATION_FILE, 'utf8');

// ---------------------------------------------------------------------------
// Try to run via pg (needs DATABASE_URL or SUPABASE_DB_URL in .env)
// ---------------------------------------------------------------------------
const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!dbUrl) {
  printManualInstructions();
  process.exit(0);
}

// Dynamically import pg — it is in devDependencies
let pg;
try {
  pg = await import('pg');
} catch {
  console.error('❌  "pg" package not found. Run: npm install --save-dev pg');
  printManualInstructions();
  process.exit(1);
}

const { default: Pg } = pg;
const client = new Pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log('✅  Connected to database.');

  // Check if the table already exists
  const check = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name   = 'chat_queue'
    ) AS exists;
  `);

  if (check.rows[0]?.exists) {
    console.log('ℹ️   chat_queue table already exists — running migration anyway (all statements use IF NOT EXISTS / CREATE OR REPLACE).');
  }

  await client.query(SQL);
  console.log('✅  Migration applied successfully!');
  console.log('    Tables created: chat_queue, chat_rooms');
  console.log('    RPCs created:   enqueue_user, dequeue_and_match, end_chat_room, cleanup_stale_queue');
} catch (err) {
  console.error('❌  Migration failed:', err.message);
  printManualInstructions();
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

// ---------------------------------------------------------------------------

function printManualInstructions() {
  console.log(`
┌─────────────────────────────────────────────────────────────────┐
│              Run this SQL in the Supabase SQL Editor            │
│  Dashboard → SQL Editor → New query → paste → Run              │
└─────────────────────────────────────────────────────────────────┘

To skip this manual step in future, add to backend/.env:
  DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres

--- BEGIN SQL ---

${SQL}
--- END SQL ---
`);
}
