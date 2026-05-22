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
  amount_ngn numeric(14,2),
  method text default 'bank_transfer',
  status text default 'pending' check (status in ('pending', 'processing', 'paid', 'completed', 'failed', 'rejected')),
  bank_name text,
  bank_code text,
  account_number text,
  account_name text,
  reference_id text,
  rejection_reason text,
  failure_reason text,
  requested_at timestamptz default now(),
  processed_at timestamptz,
  paid_at timestamptz,
  payment_provider text,
  paystack_recipient_code text,
  paystack_transfer_code text,
  paystack_transaction_reference text,
  payment_metadata jsonb default '{}',
  processed_by uuid references admin_users(id) on delete set null
);

alter table if exists creator_payout_requests
  drop constraint if exists creator_payout_requests_status_check;

alter table if exists creator_payout_requests
  add constraint creator_payout_requests_status_check
  check (status in ('pending', 'processing', 'paid', 'completed', 'failed', 'rejected'));

alter table if exists creator_payout_requests
  add column if not exists creator_email text,
  add column if not exists amount_ngn numeric(14,2),
  add column if not exists bank_name text,
  add column if not exists bank_code text,
  add column if not exists account_number text,
  add column if not exists account_name text,
  add column if not exists reference_id text,
  add column if not exists rejection_reason text,
  add column if not exists failure_reason text,
  add column if not exists paid_at timestamptz,
  add column if not exists payment_provider text,
  add column if not exists paystack_recipient_code text,
  add column if not exists paystack_transfer_code text,
  add column if not exists paystack_transaction_reference text,
  add column if not exists payment_metadata jsonb default '{}';

create table if not exists finance_payout_logs (
  id uuid primary key default gen_random_uuid(),
  payout_request_id uuid references creator_payout_requests(id) on delete set null,
  creator_id text not null,
  creator_name text,
  amount_usd numeric(12,2) not null default 0,
  amount_ngn numeric(14,2),
  transaction_reference text,
  payout_status text not null,
  payment_date timestamptz,
  provider text default 'paystack',
  error_message text,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create index if not exists idx_ad_campaigns_status on ad_campaigns(status);
create index if not exists idx_payout_requests_status on creator_payout_requests(status);
create index if not exists idx_payout_requests_creator on creator_payout_requests(creator_id);
create index if not exists idx_payout_requests_paystack_reference on creator_payout_requests(paystack_transaction_reference) where paystack_transaction_reference is not null;
create index if not exists idx_finance_payout_logs_status on finance_payout_logs(payout_status);
create index if not exists idx_finance_payout_logs_creator on finance_payout_logs(creator_id);
create index if not exists idx_finance_payout_logs_created_at on finance_payout_logs(created_at desc);
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
