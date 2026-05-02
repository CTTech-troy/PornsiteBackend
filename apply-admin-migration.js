/**
 * apply-admin-migration.js
 *
 * Creates the admin_users, admin_invites, and admin_activation_codes tables
 * in your Supabase (Postgres) database.
 *
 * Usage:
 *   node apply-admin-migration.js
 *
 * Requires one of these in backend/.env:
 *   DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
 *   — OR —
 *   SUPABASE_DB_URL=<same format>
 *
 * Find your connection string at:
 *   Supabase Dashboard → Settings → Database → Connection string → URI (Session mode, port 5432)
 *
 * If neither env var is set, the SQL is printed for you to run manually in
 * the Supabase Dashboard → SQL Editor.
 */

import 'dotenv/config';

const SQL = `
-- Admin users
create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text unique not null,
  password_hash text,
  permissions text[] not null default '{}',
  is_active boolean default false,
  is_super_admin boolean default false,
  last_login timestamptz,
  created_at timestamptz default now(),
  created_by uuid references admin_users(id) on delete set null
);

-- Admin invites
create table if not exists admin_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  permissions text[] not null default '{}',
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references admin_users(id) on delete set null,
  created_at timestamptz default now()
);

-- Admin activation codes (for self-signup flow)
create table if not exists admin_activation_codes (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references admin_users(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz default now()
);
`;

const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!dbUrl) {
  printManualInstructions();
  process.exit(0);
}

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
  await client.query(SQL);
  console.log('✅  Admin tables created (or already existed).');
  console.log('    Tables: admin_users, admin_invites, admin_activation_codes');
  console.log('');
  console.log('Next step: create your first super admin.');
  console.log('  Option A — Use the admin panel login page (/login) and click "First-time Setup"');
  console.log(`  Option B — POST http://localhost:${process.env.PORT || 5043}/api/admin/auth/founder-create`);
  console.log(`             Header: x-admin-bootstrap-secret: ${process.env.ADMIN_BOOTSTRAP_SECRET || 'xstream-bootstrap-2024'}`);
  console.log('             Body:   { "name": "Your Name", "email": "you@example.com", "password": "yourpassword" }');
} catch (err) {
  console.error('❌  Migration failed:', err.message);
  printManualInstructions();
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

function printManualInstructions() {
  console.log(`
┌─────────────────────────────────────────────────────────────────────────┐
│  Run this SQL in the Supabase Dashboard → SQL Editor → New query → Run  │
└─────────────────────────────────────────────────────────────────────────┘

${SQL}

--- After running the SQL ---
Create your first super admin by calling:

  POST http://localhost:${process.env.PORT || 5043}/api/admin/auth/founder-create
  Header: x-admin-bootstrap-secret: ${process.env.ADMIN_BOOTSTRAP_SECRET || 'xstream-bootstrap-2024'}
  Body:   { "name": "Your Name", "email": "you@example.com", "password": "yourpassword" }

Or use the admin panel login page and click "First-time Setup".
`);
}
