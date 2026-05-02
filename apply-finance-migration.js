/**
 * apply-finance-migration.js
 *
 * Creates ad_campaigns and creator_payout_requests tables.
 *
 * Usage:
 *   node apply-finance-migration.js
 *
 * Requires DATABASE_URL or SUPABASE_DB_URL in backend/.env
 */

import 'dotenv/config';

const SQL = `
-- Ad campaigns
create table if not exists ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  budget_usd numeric(12,2) default 0,
  cpc numeric(8,4) default 0,
  impressions bigint default 0,
  clicks bigint default 0,
  revenue_usd numeric(12,2) default 0,
  status text default 'active' check (status in ('active', 'paused', 'ended')),
  start_date date,
  end_date date,
  created_at timestamptz default now(),
  created_by uuid references admin_users(id) on delete set null
);

-- Creator payout requests
create table if not exists creator_payout_requests (
  id uuid primary key default gen_random_uuid(),
  creator_id text not null,
  creator_name text,
  creator_email text,
  channel_name text,
  amount_usd numeric(12,2) not null,
  method text default 'bank_transfer',
  status text default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  rejection_reason text,
  requested_at timestamptz default now(),
  processed_at timestamptz,
  processed_by uuid references admin_users(id) on delete set null
);

create index if not exists idx_ad_campaigns_status on ad_campaigns(status);
create index if not exists idx_payout_requests_status on creator_payout_requests(status);
create index if not exists idx_payout_requests_creator on creator_payout_requests(creator_id);
`;

const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!dbUrl) {
  printManualInstructions();
  process.exit(0);
}

let pg;
try { pg = await import('pg'); } catch {
  console.error('❌  "pg" not found. Run: npm install --save-dev pg');
  printManualInstructions();
  process.exit(1);
}

const client = new pg.default.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  console.log('✅  Connected to database.');
  await client.query(SQL);
  console.log('✅  Finance tables created (or already existed).');
  console.log('    Tables: ad_campaigns, creator_payout_requests');
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
`);
}
