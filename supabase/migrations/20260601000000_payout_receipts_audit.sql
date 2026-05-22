-- Payout receipts, wallet ledger, email queue, and extended payout request fields

create sequence if not exists public.payout_receipt_number_seq start 1;

alter table public.creator_payout_requests
  add column if not exists receipt_number text,
  add column if not exists wallet_balance_before numeric(14,2),
  add column if not exists wallet_balance_after numeric(14,2),
  add column if not exists remaining_balance_after numeric(14,2),
  add column if not exists processing_lock_at timestamptz,
  add column if not exists processing_lock_by text,
  add column if not exists version integer not null default 1,
  add column if not exists paid_by_admin_id text,
  add column if not exists rejected_by_admin_id text,
  add column if not exists creator_phone text,
  add column if not exists creator_avatar_url text;

create unique index if not exists creator_payout_requests_receipt_number_idx
  on public.creator_payout_requests(receipt_number)
  where receipt_number is not null;

create index if not exists creator_payout_requests_paid_at_idx
  on public.creator_payout_requests(paid_at)
  where paid_at is not null;

create table if not exists public.payout_receipts (
  id uuid primary key default gen_random_uuid(),
  payout_request_id uuid not null references public.creator_payout_requests(id) on delete cascade,
  type text not null check (type in ('paid', 'rejected')),
  receipt_number text not null,
  html_body text,
  pdf_storage_path text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create unique index if not exists payout_receipts_number_idx
  on public.payout_receipts(receipt_number);

create index if not exists payout_receipts_request_idx
  on public.payout_receipts(payout_request_id, created_at desc);

create table if not exists public.creator_wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  creator_id text not null,
  delta_usd numeric(14,2) not null default 0,
  balance_after numeric(14,2) not null default 0,
  source text not null check (source in ('withdrawal_hold', 'withdrawal_release', 'withdrawal_paid', 'earning')),
  reference_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists creator_wallet_ledger_creator_idx
  on public.creator_wallet_ledger(creator_id, created_at desc);

create index if not exists creator_wallet_ledger_created_idx
  on public.creator_wallet_ledger(created_at desc);

create table if not exists public.finance_email_queue (
  id uuid primary key default gen_random_uuid(),
  to_email text not null,
  subject text not null,
  html_body text not null,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  retry_count integer not null default 0,
  last_error text,
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists finance_email_queue_status_idx
  on public.finance_email_queue(status, scheduled_at);

-- Alias table for plan naming (payout_audit_events); reuse payout_audit_logs
create or replace view public.payout_audit_events as
  select * from public.payout_audit_logs;
