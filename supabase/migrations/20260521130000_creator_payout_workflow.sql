create extension if not exists pgcrypto;

create table if not exists public.creator_payout_requests (
  id uuid primary key default gen_random_uuid(),
  creator_id text not null,
  creator_name text,
  creator_email text,
  channel_name text,
  amount_usd numeric(12,2) not null default 0,
  amount_ngn numeric(14,2),
  bank_name text,
  bank_code text,
  account_number text,
  account_name text,
  method text not null default 'bank_transfer',
  reference_id text,
  status text not null default 'pending',
  rejection_reason text,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by text
);

alter table public.creator_payout_requests
  drop constraint if exists creator_payout_requests_status_check;

alter table public.creator_payout_requests
  add constraint creator_payout_requests_status_check
  check (status in ('pending', 'approved', 'processing', 'paid', 'completed', 'failed', 'rejected'));

alter table public.creator_payout_requests
  add column if not exists account_name text,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text,
  add column if not exists finance_assignee_id text,
  add column if not exists finance_assigned_at timestamptz,
  add column if not exists finance_status text,
  add column if not exists admin_notes text,
  add column if not exists internal_notes text,
  add column if not exists risk_score integer not null default 0,
  add column if not exists risk_flags text[] not null default '{}',
  add column if not exists locked_amount_usd numeric(12,2),
  add column if not exists paid_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists payment_provider text,
  add column if not exists transaction_reference text,
  add column if not exists proof_url text,
  add column if not exists paystack_recipient_code text,
  add column if not exists paystack_transfer_code text,
  add column if not exists paystack_transaction_reference text,
  add column if not exists failure_reason text,
  add column if not exists retry_count integer not null default 0,
  add column if not exists last_retry_at timestamptz,
  add column if not exists qstash_message_id text,
  add column if not exists payment_metadata jsonb not null default '{}',
  add column if not exists updated_at timestamptz not null default now();

alter table public.wallets
  add column if not exists pending_payout_balance numeric(14,2) not null default 0,
  add column if not exists processing_payout_balance numeric(14,2) not null default 0,
  add column if not exists withdrawn_payout_balance numeric(14,2) not null default 0;

create index if not exists creator_payout_requests_status_idx
  on public.creator_payout_requests(status);

create index if not exists creator_payout_requests_creator_idx
  on public.creator_payout_requests(creator_id);

create index if not exists creator_payout_requests_requested_idx
  on public.creator_payout_requests(requested_at desc);

create index if not exists creator_payout_requests_finance_idx
  on public.creator_payout_requests(finance_assignee_id, status);

create unique index if not exists creator_payout_requests_reference_idx
  on public.creator_payout_requests(reference_id)
  where reference_id is not null;

create unique index if not exists creator_payout_one_active_idx
  on public.creator_payout_requests(creator_id)
  where status in ('pending', 'approved', 'processing');

create table if not exists public.payout_transactions (
  id uuid primary key default gen_random_uuid(),
  payout_request_id uuid references public.creator_payout_requests(id) on delete cascade,
  creator_id text not null,
  provider text not null default 'manual',
  provider_reference text,
  transaction_reference text,
  amount_usd numeric(12,2) not null default 0,
  amount_ngn numeric(14,2),
  status text not null default 'queued',
  attempt integer not null default 1,
  proof_url text,
  metadata jsonb not null default '{}',
  error_message text,
  verified_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payout_transactions_request_idx
  on public.payout_transactions(payout_request_id, created_at desc);

create index if not exists payout_transactions_status_idx
  on public.payout_transactions(status);

create table if not exists public.payout_audit_logs (
  id uuid primary key default gen_random_uuid(),
  payout_request_id uuid references public.creator_payout_requests(id) on delete cascade,
  actor_id text,
  actor_type text not null default 'system',
  action text not null,
  from_status text,
  to_status text,
  notes text,
  metadata jsonb not null default '{}',
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists payout_audit_logs_request_idx
  on public.payout_audit_logs(payout_request_id, created_at desc);

create table if not exists public.creator_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  type text not null,
  title text not null,
  message text not null,
  data jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists creator_notifications_user_idx
  on public.creator_notifications(user_id, created_at desc);

create table if not exists public.finance_notifications (
  id uuid primary key default gen_random_uuid(),
  role text not null default 'finance',
  type text not null,
  title text not null,
  message text not null,
  data jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists finance_notifications_role_idx
  on public.finance_notifications(role, created_at desc);

create table if not exists public.payout_daily_summaries (
  summary_date date primary key,
  total_payouts numeric(14,2) not null default 0,
  pending_payouts numeric(14,2) not null default 0,
  processing_payouts numeric(14,2) not null default 0,
  completed_payouts numeric(14,2) not null default 0,
  failed_payouts numeric(14,2) not null default 0,
  request_count integer not null default 0,
  completed_count integer not null default 0,
  failed_count integer not null default 0,
  avg_processing_minutes numeric(12,2) not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.request_creator_withdrawal(
  p_creator_id text,
  p_creator_name text,
  p_creator_email text,
  p_amount_usd numeric,
  p_amount_ngn numeric,
  p_bank_name text,
  p_bank_code text,
  p_account_number text,
  p_account_name text,
  p_reference_id text,
  p_method text default 'bank_transfer',
  p_risk_score integer default 0,
  p_risk_flags text[] default '{}'
)
returns public.creator_payout_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet wallets%rowtype;
  v_total_earned numeric(14,2);
  v_committed_payouts numeric(14,2);
  v_available numeric(14,2);
  v_request creator_payout_requests%rowtype;
begin
  if p_amount_usd is null or p_amount_usd <= 0 then
    raise exception 'Withdrawal amount must be positive';
  end if;

  insert into wallets (owner_id, balance)
  values (p_creator_id, 0)
  on conflict (owner_id) do nothing;

  select * into v_wallet
    from wallets
   where owner_id = p_creator_id
   for update;

  if exists (
    select 1
      from creator_payout_requests
     where creator_id = p_creator_id
       and status in ('pending', 'approved', 'processing')
  ) then
    raise exception 'Creator already has an active withdrawal request';
  end if;

  select coalesce(sum(amount_usd), 0)
    into v_total_earned
    from creator_earnings
   where creator_id = p_creator_id;

  select coalesce(sum(amount_usd), 0)
    into v_committed_payouts
    from creator_payout_requests
   where creator_id = p_creator_id
     and status in ('pending', 'approved', 'processing', 'paid', 'completed');

  v_available := greatest(0, v_total_earned - v_committed_payouts);

  if p_amount_usd > v_available then
    raise exception 'Insufficient available balance: have %, need %', v_available, p_amount_usd;
  end if;

  insert into creator_payout_requests (
    creator_id,
    creator_name,
    creator_email,
    amount_usd,
    amount_ngn,
    bank_name,
    bank_code,
    account_number,
    account_name,
    reference_id,
    method,
    status,
    locked_amount_usd,
    risk_score,
    risk_flags,
    requested_at,
    updated_at
  )
  values (
    p_creator_id,
    p_creator_name,
    p_creator_email,
    round(p_amount_usd, 2),
    p_amount_ngn,
    p_bank_name,
    p_bank_code,
    p_account_number,
    p_account_name,
    p_reference_id,
    coalesce(p_method, 'bank_transfer'),
    'pending',
    round(p_amount_usd, 2),
    coalesce(p_risk_score, 0),
    coalesce(p_risk_flags, '{}'),
    now(),
    now()
  )
  returning * into v_request;

  update wallets
     set pending_payout_balance = pending_payout_balance + round(p_amount_usd, 2),
         updated_at = now()
   where owner_id = p_creator_id;

  return v_request;
end;
$$;

create or replace function public.transition_creator_payout_status(
  p_payout_id uuid,
  p_next_status text,
  p_actor_id text default null,
  p_reason text default null,
  p_transaction_reference text default null,
  p_proof_url text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.creator_payout_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout creator_payout_requests%rowtype;
  v_amount numeric(14,2);
  v_from text;
  v_now timestamptz := now();
begin
  if p_next_status not in ('pending', 'approved', 'processing', 'paid', 'completed', 'failed', 'rejected') then
    raise exception 'Invalid payout status %', p_next_status;
  end if;

  select * into v_payout
    from creator_payout_requests
   where id = p_payout_id
   for update;

  if not found then
    raise exception 'Payout request not found';
  end if;

  insert into wallets (owner_id, balance)
  values (v_payout.creator_id, 0)
  on conflict (owner_id) do nothing;

  perform 1 from wallets where owner_id = v_payout.creator_id for update;

  v_amount := round(coalesce(v_payout.locked_amount_usd, v_payout.amount_usd, 0), 2);
  v_from := v_payout.status;

  if v_from = p_next_status then
    return v_payout;
  end if;

  if v_from = 'pending' and p_next_status not in ('approved', 'processing', 'rejected', 'failed') then
    raise exception 'Invalid payout transition from % to %', v_from, p_next_status;
  end if;

  if v_from = 'approved' and p_next_status not in ('processing', 'rejected', 'failed') then
    raise exception 'Invalid payout transition from % to %', v_from, p_next_status;
  end if;

  if v_from = 'processing' and p_next_status not in ('paid', 'completed', 'failed', 'rejected') then
    raise exception 'Invalid payout transition from % to %', v_from, p_next_status;
  end if;

  if v_from = 'paid' and p_next_status not in ('completed', 'failed') then
    raise exception 'Invalid payout transition from % to %', v_from, p_next_status;
  end if;

  if v_from = 'completed' or v_from = 'rejected' then
    raise exception 'Payout request is already final';
  end if;

  if v_from = 'failed' and p_next_status not in ('processing', 'rejected') then
    raise exception 'Invalid payout transition from % to %', v_from, p_next_status;
  end if;

  if v_from = 'pending' and p_next_status in ('approved', 'processing') then
    update wallets
       set pending_payout_balance = greatest(0, pending_payout_balance - v_amount),
           processing_payout_balance = processing_payout_balance + v_amount,
           updated_at = v_now
     where owner_id = v_payout.creator_id;
  elsif v_from in ('pending', 'approved', 'processing') and p_next_status in ('rejected', 'failed') then
    update wallets
       set pending_payout_balance =
             case when v_from = 'pending' then greatest(0, pending_payout_balance - v_amount) else pending_payout_balance end,
           processing_payout_balance =
             case when v_from in ('approved', 'processing') then greatest(0, processing_payout_balance - v_amount) else processing_payout_balance end,
           updated_at = v_now
     where owner_id = v_payout.creator_id;
  elsif v_from in ('approved', 'processing') and p_next_status in ('paid', 'completed') then
    update wallets
       set processing_payout_balance = greatest(0, processing_payout_balance - v_amount),
           withdrawn_payout_balance = withdrawn_payout_balance + v_amount,
           updated_at = v_now
     where owner_id = v_payout.creator_id;
  elsif v_from = 'paid' and p_next_status = 'completed' then
    -- Money was already counted as withdrawn when it moved to paid.
    update wallets set updated_at = v_now where owner_id = v_payout.creator_id;
  elsif v_from = 'failed' and p_next_status = 'processing' then
    update wallets
       set processing_payout_balance = processing_payout_balance + v_amount,
           updated_at = v_now
     where owner_id = v_payout.creator_id;
  end if;

  update creator_payout_requests
     set status = p_next_status,
         approved_at = case when p_next_status in ('approved', 'processing') and approved_at is null then v_now else approved_at end,
         approved_by = case when p_next_status in ('approved', 'processing') and approved_by is null then p_actor_id else approved_by end,
         finance_assigned_at = case when p_next_status = 'processing' and finance_assigned_at is null then v_now else finance_assigned_at end,
         processed_at = case when p_next_status in ('processing', 'paid', 'completed', 'failed', 'rejected') then v_now else processed_at end,
         processed_by = coalesce(p_actor_id, processed_by),
         paid_at = case when p_next_status in ('paid', 'completed') and paid_at is null then v_now else paid_at end,
         completed_at = case when p_next_status = 'completed' then v_now else completed_at end,
         failure_reason = case when p_next_status = 'failed' then p_reason else failure_reason end,
         rejection_reason = case when p_next_status = 'rejected' then p_reason else rejection_reason end,
         transaction_reference = coalesce(p_transaction_reference, transaction_reference),
         proof_url = coalesce(p_proof_url, proof_url),
         payment_metadata = coalesce(payment_metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         retry_count = case when v_from = 'failed' and p_next_status = 'processing' then retry_count + 1 else retry_count end,
         last_retry_at = case when v_from = 'failed' and p_next_status = 'processing' then v_now else last_retry_at end,
         updated_at = v_now
   where id = p_payout_id
   returning * into v_payout;

  return v_payout;
end;
$$;

create or replace function public.refresh_payout_daily_summary(p_summary_date date default current_date)
returns public.payout_daily_summaries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row payout_daily_summaries%rowtype;
begin
  insert into payout_daily_summaries (
    summary_date,
    total_payouts,
    pending_payouts,
    processing_payouts,
    completed_payouts,
    failed_payouts,
    request_count,
    completed_count,
    failed_count,
    avg_processing_minutes,
    updated_at
  )
  select
    p_summary_date,
    coalesce(sum(amount_usd), 0),
    coalesce(sum(amount_usd) filter (where status = 'pending'), 0),
    coalesce(sum(amount_usd) filter (where status in ('approved', 'processing')), 0),
    coalesce(sum(amount_usd) filter (where status in ('paid', 'completed')), 0),
    coalesce(sum(amount_usd) filter (where status = 'failed'), 0),
    count(*)::integer,
    count(*) filter (where status in ('paid', 'completed'))::integer,
    count(*) filter (where status = 'failed')::integer,
    coalesce(avg(extract(epoch from (coalesce(completed_at, paid_at, processed_at) - requested_at)) / 60)
      filter (where status in ('paid', 'completed') and requested_at is not null), 0),
    now()
  from creator_payout_requests
  where requested_at >= p_summary_date::timestamptz
    and requested_at < (p_summary_date + 1)::timestamptz
  on conflict (summary_date) do update set
    total_payouts = excluded.total_payouts,
    pending_payouts = excluded.pending_payouts,
    processing_payouts = excluded.processing_payouts,
    completed_payouts = excluded.completed_payouts,
    failed_payouts = excluded.failed_payouts,
    request_count = excluded.request_count,
    completed_count = excluded.completed_count,
    failed_count = excluded.failed_count,
    avg_processing_minutes = excluded.avg_processing_minutes,
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.request_creator_withdrawal(text, text, text, numeric, numeric, text, text, text, text, text, text, integer, text[]) to service_role;
grant execute on function public.transition_creator_payout_status(uuid, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.refresh_payout_daily_summary(date) to service_role;

alter table public.payout_transactions enable row level security;
alter table public.payout_audit_logs enable row level security;
alter table public.creator_notifications enable row level security;
alter table public.finance_notifications enable row level security;
alter table public.payout_daily_summaries enable row level security;

grant select, insert, update, delete on public.creator_payout_requests to service_role;
grant select, insert, update, delete on public.wallets to service_role;
grant select, insert, update, delete on public.payout_transactions to service_role;
grant select, insert, update, delete on public.payout_audit_logs to service_role;
grant select, insert, update, delete on public.creator_notifications to service_role;
grant select, insert, update, delete on public.finance_notifications to service_role;
grant select, insert, update, delete on public.payout_daily_summaries to service_role;
