-- Production monetization split:
-- 1) Membership subscriptions expire and carry access permissions.
-- 2) Virtual coins are wallet credits and do not behave like subscriptions.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Membership catalog and lifecycle
-- ---------------------------------------------------------------------------
alter table if exists public.membership_plans
  add column if not exists duration_type text not null default 'days',
  add column if not exists duration_value integer not null default 30,
  add column if not exists badge text,
  add column if not exists permissions jsonb not null default '{}'::jsonb,
  add column if not exists limits jsonb not null default '{}'::jsonb,
  add column if not exists creator_benefits jsonb not null default '{}'::jsonb,
  add column if not exists ai_access jsonb not null default '{}'::jsonb,
  add column if not exists visibility_priority integer not null default 0,
  add column if not exists coin_bonus numeric(18,2) not null default 0,
  add column if not exists is_recurring boolean not null default false,
  add column if not exists archived_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

update public.membership_plans
   set duration_type = coalesce(nullif(duration_type, ''), 'days'),
       duration_value = case
         when duration_value is null or duration_value <= 0 then greatest(coalesce(duration_days, 30), 1)
         else duration_value
       end
 where duration_type is null
    or duration_value is null
    or duration_value <= 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'membership_plans_duration_type_check'
  ) then
    alter table public.membership_plans
      add constraint membership_plans_duration_type_check
      check (duration_type in ('days', 'weeks', 'months', 'years'));
  end if;
end $$;

alter table if exists public.user_memberships
  add column if not exists renewal_status text not null default 'none',
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists paused_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists next_billing_at timestamptz,
  add column if not exists provider_subscription_id text,
  add column if not exists provider_customer_id text,
  add column if not exists provider_metadata jsonb not null default '{}'::jsonb,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.user_memberships
  drop constraint if exists user_memberships_status_check;

alter table if exists public.user_memberships
  add constraint user_memberships_status_check
  check (status in ('active', 'grace', 'expired', 'cancelled', 'paused', 'past_due', 'failed'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_memberships_renewal_status_check'
  ) then
    alter table public.user_memberships
      add constraint user_memberships_renewal_status_check
      check (renewal_status in ('none', 'active', 'cancel_at_period_end', 'paused', 'past_due', 'failed'));
  end if;
end $$;

create index if not exists user_memberships_user_status_expires_idx
  on public.user_memberships(user_id, status, expires_at desc);

create index if not exists user_memberships_next_billing_idx
  on public.user_memberships(next_billing_at)
  where next_billing_at is not null;

create table if not exists public.membership_features (
  id uuid primary key default gen_random_uuid(),
  plan_id text not null references public.membership_plans(id) on delete cascade,
  feature_key text not null,
  label text not null,
  value jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(plan_id, feature_key)
);

create table if not exists public.membership_billing_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  membership_id uuid references public.user_memberships(id) on delete set null,
  order_id uuid,
  provider text,
  provider_reference text,
  amount numeric(18,2) not null default 0,
  currency text not null default 'USD',
  status text not null default 'pending',
  billing_reason text not null default 'initial_purchase',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists membership_billing_logs_user_idx
  on public.membership_billing_logs(user_id, created_at desc);

create unique index if not exists membership_billing_logs_provider_reference_idx
  on public.membership_billing_logs(provider_reference)
  where provider_reference is not null;

create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  membership_id uuid references public.user_memberships(id) on delete set null,
  event_type text not null,
  status text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists subscription_events_user_idx
  on public.subscription_events(user_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Payment intents shared by memberships and coin purchases
-- ---------------------------------------------------------------------------
create table if not exists public.monetization_orders (
  id uuid primary key default gen_random_uuid(),
  order_key text not null unique,
  user_id text not null,
  product_type text not null check (product_type in ('membership', 'coins')),
  product_id text not null,
  amount numeric(18,2) not null default 0,
  currency text not null default 'USD',
  provider text,
  provider_reference text,
  checkout_url text,
  status text not null default 'pending'
    check (status in ('pending', 'checkout_created', 'paid', 'fulfilled', 'failed', 'cancelled')),
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fulfilled_at timestamptz
);

create unique index if not exists monetization_orders_provider_reference_idx
  on public.monetization_orders(provider_reference)
  where provider_reference is not null;

create unique index if not exists monetization_orders_idempotency_idx
  on public.monetization_orders(idempotency_key)
  where idempotency_key is not null;

create index if not exists monetization_orders_user_idx
  on public.monetization_orders(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Coin wallet system
-- ---------------------------------------------------------------------------
create table if not exists public.coin_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  balance numeric(18,2) not null default 0 check (balance >= 0),
  lifetime_purchased numeric(18,2) not null default 0,
  lifetime_spent numeric(18,2) not null default 0,
  lifetime_received numeric(18,2) not null default 0,
  lifetime_adjusted numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.coin_packages (
  id text primary key,
  name text not null,
  description text,
  coins numeric(18,2) not null check (coins > 0),
  bonus_coins numeric(18,2) not null default 0 check (bonus_coins >= 0),
  price_usd numeric(18,2) not null default 0 check (price_usd >= 0),
  price_ngn numeric(18,2) not null default 0 check (price_ngn >= 0),
  currency text not null default 'USD',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  expires_after_days integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.coin_wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid references public.coin_wallets(id) on delete cascade,
  user_id text not null,
  type text not null check (type in (
    'purchase', 'bonus', 'spend', 'transfer_in', 'transfer_out',
    'gift_sent', 'gift_received', 'refund', 'adjustment', 'expiration'
  )),
  amount numeric(18,2) not null,
  balance_before numeric(18,2) not null default 0,
  balance_after numeric(18,2) not null default 0,
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed', 'reversed')),
  provider text,
  reference text,
  related_user_id text,
  source_type text,
  source_id text,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists coin_wallet_transactions_user_idx
  on public.coin_wallet_transactions(user_id, created_at desc);

create unique index if not exists coin_wallet_transactions_reference_idx
  on public.coin_wallet_transactions(reference)
  where reference is not null;

create unique index if not exists coin_wallet_transactions_idempotency_idx
  on public.coin_wallet_transactions(idempotency_key)
  where idempotency_key is not null;

create table if not exists public.coin_transfers (
  id uuid primary key default gen_random_uuid(),
  sender_id text not null,
  recipient_id text not null,
  amount numeric(18,2) not null check (amount > 0),
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed', 'reversed')),
  reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists coin_transfers_sender_idx
  on public.coin_transfers(sender_id, created_at desc);

create index if not exists coin_transfers_recipient_idx
  on public.coin_transfers(recipient_id, created_at desc);

create unique index if not exists coin_transfers_reference_idx
  on public.coin_transfers(reference)
  where reference is not null;

create table if not exists public.coin_analytics_daily (
  period_date date primary key,
  coins_sold numeric(18,2) not null default 0,
  coins_spent numeric(18,2) not null default 0,
  coins_transferred numeric(18,2) not null default 0,
  revenue_usd numeric(18,2) not null default 0,
  transactions integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Backfill coin wallets from the legacy users.coin_balance mirror.
insert into public.coin_wallets (user_id, balance, created_at, updated_at)
select id, greatest(coalesce(coin_balance, 0), 0), now(), now()
  from public.users
 where id is not null
on conflict (user_id) do update
  set balance = greatest(public.coin_wallets.balance, excluded.balance),
      updated_at = now();

-- Mirror legacy token transaction history when the old table exists (optional).
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'token_transactions'
  ) then
    return;
  end if;

  insert into public.coin_wallets (user_id, balance, created_at, updated_at)
  select distinct tt.user_id,
         greatest(coalesce(u.coin_balance, 0), 0),
         now(),
         now()
    from public.token_transactions tt
    left join public.users u on u.id = tt.user_id
   where tt.user_id is not null
  on conflict (user_id) do nothing;

  insert into public.coin_wallet_transactions (
    wallet_id,
    user_id,
    type,
    amount,
    balance_before,
    balance_after,
    status,
    provider,
    reference,
    source_type,
    source_id,
    idempotency_key,
    metadata,
    created_at
  )
  select cw.id,
         tt.user_id,
         case
           when tt.type in ('purchase', 'gift_sent', 'gift_received', 'refund', 'adjustment') then tt.type
           else 'adjustment'
         end,
         case
           when tt.type = 'gift_sent' and tt.amount > 0 then -tt.amount
           else tt.amount
         end,
         0,
         0,
         coalesce(tt.status, 'completed'),
         null,
         'legacy-token-tx:' || tt.id::text,
         'legacy_token_transactions',
         tt.id::text,
         'legacy-token-tx:' || tt.id::text,
         coalesce(tt.metadata, '{}'::jsonb) || jsonb_build_object(
           'legacyTokenTransactionId', tt.id,
           'legacyReference', tt.reference,
           'paymentAmount', tt.payment_amount,
           'paymentCurrency', tt.payment_currency
         ),
         tt.created_at
    from public.token_transactions tt
    join public.coin_wallets cw on cw.user_id = tt.user_id
   where tt.user_id is not null
  on conflict (idempotency_key) where idempotency_key is not null do nothing;
end $$;

-- Convert legacy mixed "coins_*" plans into coin packages, then hide them
-- from new membership purchases while preserving historical memberships.
insert into public.coin_packages (id, name, description, coins, price_usd, price_ngn, sort_order, metadata)
select id,
       name,
       description,
       greatest(coalesce(coins, 0), 1),
       coalesce(price_usd, 0),
       coalesce(price_ngn, 0),
       coalesce(sort_order, 0),
       jsonb_build_object('migratedFrom', 'membership_plans', 'legacyPlanId', id)
  from public.membership_plans
 where id in ('coins_30', 'coins_60', 'coins_120')
on conflict (id) do update
  set name = excluded.name,
      description = excluded.description,
      coins = excluded.coins,
      price_usd = excluded.price_usd,
      price_ngn = excluded.price_ngn,
      updated_at = now();

update public.membership_plans
   set is_active = false,
       archived_at = coalesce(archived_at, now()),
       metadata = coalesce(metadata, '{}'::jsonb) || '{"legacyCoinPlan": true}'::jsonb
 where id in ('coins_30', 'coins_60', 'coins_120');

insert into public.coin_packages (id, name, description, coins, price_usd, price_ngn, sort_order)
values
  ('tokens_30', '30 Coins', 'Starter coin package', 30, 0.99, 1499, 10),
  ('tokens_100', '100 Coins', 'Popular coin package', 100, 2.99, 4499, 20),
  ('tokens_300', '300 Coins', 'Best value coin package', 300, 7.99, 11999, 30)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Atomic wallet RPCs
-- ---------------------------------------------------------------------------
create or replace function public.ensure_coin_wallet(p_user_id text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet_id uuid;
  v_legacy_balance numeric;
begin
  if p_user_id is null or length(trim(p_user_id)) = 0 then
    raise exception 'user_id_required';
  end if;

  insert into public.users (id) values (p_user_id) on conflict (id) do nothing;

  select coalesce(coin_balance, 0) into v_legacy_balance
    from public.users
   where id = p_user_id;

  insert into public.coin_wallets (user_id, balance)
  values (p_user_id, greatest(coalesce(v_legacy_balance, 0), 0))
  on conflict (user_id) do update
    set updated_at = now()
  returning id into v_wallet_id;

  return v_wallet_id;
end;
$$;

create or replace function public.credit_coin_wallet(
  p_user_id text,
  p_amount numeric,
  p_type text default 'purchase',
  p_reference text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_provider text default null,
  p_source_type text default null,
  p_source_id text default null
)
returns table(new_balance numeric, transaction_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet coin_wallets%rowtype;
  v_before numeric;
  v_after numeric;
  v_tx uuid;
begin
  if p_amount <= 0 then
    raise exception 'coin amount must be positive';
  end if;

  if p_idempotency_key is not null then
    select balance_after, id into v_after, v_tx
      from public.coin_wallet_transactions
     where idempotency_key = p_idempotency_key
     limit 1;
    if found then
      return query select v_after, v_tx;
      return;
    end if;
  end if;

  perform public.ensure_coin_wallet(p_user_id);

  select * into v_wallet
    from public.coin_wallets
   where user_id = p_user_id
   for update;

  v_before := v_wallet.balance;
  v_after := v_before + p_amount;

  update public.coin_wallets
     set balance = v_after,
         lifetime_purchased = lifetime_purchased + case when p_type = 'purchase' then p_amount else 0 end,
         lifetime_received = lifetime_received + case when p_type in ('transfer_in', 'gift_received', 'bonus') then p_amount else 0 end,
         lifetime_adjusted = lifetime_adjusted + case when p_type = 'adjustment' then p_amount else 0 end,
         updated_at = now()
   where id = v_wallet.id;

  update public.users set coin_balance = v_after where id = p_user_id;

  insert into public.coin_wallet_transactions (
    wallet_id, user_id, type, amount, balance_before, balance_after,
    provider, reference, idempotency_key, source_type, source_id, metadata
  )
  values (
    v_wallet.id, p_user_id, p_type, p_amount, v_before, v_after,
    p_provider, p_reference, p_idempotency_key, p_source_type, p_source_id, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_tx;

  return query select v_after, v_tx;
end;
$$;

create or replace function public.debit_coin_wallet(
  p_user_id text,
  p_amount numeric,
  p_type text default 'spend',
  p_reference text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_related_user_id text default null,
  p_source_type text default null,
  p_source_id text default null
)
returns table(new_balance numeric, transaction_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet coin_wallets%rowtype;
  v_before numeric;
  v_after numeric;
  v_tx uuid;
begin
  if p_amount <= 0 then
    raise exception 'coin amount must be positive';
  end if;

  if p_idempotency_key is not null then
    select balance_after, id into v_after, v_tx
      from public.coin_wallet_transactions
     where idempotency_key = p_idempotency_key
     limit 1;
    if found then
      return query select v_after, v_tx;
      return;
    end if;
  end if;

  perform public.ensure_coin_wallet(p_user_id);

  select * into v_wallet
    from public.coin_wallets
   where user_id = p_user_id
   for update;

  if v_wallet.balance < p_amount then
    raise exception 'insufficient_coins'
      using hint = 'coin_balance',
            detail = format('balance=%s required=%s', v_wallet.balance, p_amount);
  end if;

  v_before := v_wallet.balance;
  v_after := v_before - p_amount;

  update public.coin_wallets
     set balance = v_after,
         lifetime_spent = lifetime_spent + p_amount,
         updated_at = now()
   where id = v_wallet.id;

  update public.users set coin_balance = v_after where id = p_user_id;

  insert into public.coin_wallet_transactions (
    wallet_id, user_id, type, amount, balance_before, balance_after,
    reference, related_user_id, idempotency_key, source_type, source_id, metadata
  )
  values (
    v_wallet.id, p_user_id, p_type, -p_amount, v_before, v_after,
    p_reference, p_related_user_id, p_idempotency_key, p_source_type, p_source_id, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_tx;

  return query select v_after, v_tx;
end;
$$;

create or replace function public.transfer_coin_wallet(
  p_sender_id text,
  p_recipient_id text,
  p_amount numeric,
  p_reference text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_source_type text default 'transfer',
  p_source_id text default null
)
returns table(sender_balance numeric, recipient_balance numeric, transfer_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender coin_wallets%rowtype;
  v_recipient coin_wallets%rowtype;
  v_transfer uuid;
  v_transfer_reference text;
begin
  if p_sender_id = p_recipient_id then
    raise exception 'cannot_transfer_to_self';
  end if;
  if p_amount <= 0 then
    raise exception 'coin amount must be positive';
  end if;

  v_transfer_reference := coalesce(p_idempotency_key, p_reference);

  if v_transfer_reference is not null then
    select id into v_transfer
      from public.coin_transfers
     where reference = v_transfer_reference
     limit 1;
    if found then
      select balance into sender_balance from public.coin_wallets where user_id = p_sender_id;
      select balance into recipient_balance from public.coin_wallets where user_id = p_recipient_id;
      transfer_id := v_transfer;
      return next;
      return;
    end if;
  end if;

  perform public.ensure_coin_wallet(p_sender_id);
  perform public.ensure_coin_wallet(p_recipient_id);

  select * into v_sender
    from public.coin_wallets
   where user_id = p_sender_id
   for update;

  if v_sender.balance < p_amount then
    raise exception 'insufficient_coins'
      using hint = 'coin_balance',
            detail = format('balance=%s required=%s', v_sender.balance, p_amount);
  end if;

  select * into v_recipient
    from public.coin_wallets
   where user_id = p_recipient_id
   for update;

  insert into public.coin_transfers (sender_id, recipient_id, amount, reference, metadata)
  values (p_sender_id, p_recipient_id, p_amount, v_transfer_reference, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_transfer;

  update public.coin_wallets
     set balance = balance - p_amount,
         lifetime_spent = lifetime_spent + p_amount,
         updated_at = now()
   where id = v_sender.id
   returning balance into sender_balance;

  update public.users set coin_balance = sender_balance where id = p_sender_id;

  update public.coin_wallets
     set balance = balance + p_amount,
         lifetime_received = lifetime_received + p_amount,
         updated_at = now()
   where id = v_recipient.id
   returning balance into recipient_balance;

  update public.users set coin_balance = recipient_balance where id = p_recipient_id;

  insert into public.coin_wallet_transactions (
    wallet_id, user_id, type, amount, balance_before, balance_after,
    reference, related_user_id, idempotency_key, source_type, source_id, metadata
  )
  values
    (
      v_sender.id, p_sender_id,
      case when p_source_type = 'gift' then 'gift_sent' else 'transfer_out' end,
      -p_amount, v_sender.balance, sender_balance,
      case when p_reference is null then null else p_reference || ':out' end,
      p_recipient_id,
      case when p_idempotency_key is null then null else p_idempotency_key || ':out' end,
      p_source_type, p_source_id, coalesce(p_metadata, '{}'::jsonb)
    ),
    (
      v_recipient.id, p_recipient_id,
      case when p_source_type = 'gift' then 'gift_received' else 'transfer_in' end,
      p_amount, v_recipient.balance, recipient_balance,
      case when p_reference is null then null else p_reference || ':in' end,
      p_sender_id,
      case when p_idempotency_key is null then null else p_idempotency_key || ':in' end,
      p_source_type, p_source_id, coalesce(p_metadata, '{}'::jsonb)
    );

  transfer_id := v_transfer;
  return next;
end;
$$;

create or replace function public.adjust_coin_wallet(
  p_user_id text,
  p_delta numeric,
  p_actor_id text default null,
  p_reason text default null,
  p_reference text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table(new_balance numeric, transaction_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_delta = 0 then
    raise exception 'coin adjustment cannot be zero';
  end if;

  if p_delta > 0 then
    return query
      select * from public.credit_coin_wallet(
        p_user_id,
        p_delta,
        'adjustment',
        p_reference,
        coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('actorId', p_actor_id, 'reason', p_reason),
        null,
        null,
        'admin_adjustment',
        p_actor_id
      );
  else
    return query
      select * from public.debit_coin_wallet(
        p_user_id,
        abs(p_delta),
        'adjustment',
        p_reference,
        coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('actorId', p_actor_id, 'reason', p_reason),
        null,
        p_actor_id,
        'admin_adjustment',
        p_actor_id
      );
  end if;
end;
$$;

revoke all on function public.ensure_coin_wallet(text) from public;
revoke all on function public.credit_coin_wallet(text, numeric, text, text, jsonb, text, text, text, text) from public;
revoke all on function public.debit_coin_wallet(text, numeric, text, text, jsonb, text, text, text, text) from public;
revoke all on function public.transfer_coin_wallet(text, text, numeric, text, jsonb, text, text, text) from public;
revoke all on function public.adjust_coin_wallet(text, numeric, text, text, text, jsonb) from public;

grant execute on function public.ensure_coin_wallet(text) to service_role;
grant execute on function public.credit_coin_wallet(text, numeric, text, text, jsonb, text, text, text, text) to service_role;
grant execute on function public.debit_coin_wallet(text, numeric, text, text, jsonb, text, text, text, text) to service_role;
grant execute on function public.transfer_coin_wallet(text, text, numeric, text, jsonb, text, text, text) to service_role;
grant execute on function public.adjust_coin_wallet(text, numeric, text, text, text, jsonb) to service_role;

alter table public.coin_wallets enable row level security;
alter table public.coin_packages enable row level security;
alter table public.coin_wallet_transactions enable row level security;
alter table public.coin_transfers enable row level security;
alter table public.membership_features enable row level security;
alter table public.membership_billing_logs enable row level security;
alter table public.subscription_events enable row level security;
alter table public.monetization_orders enable row level security;

drop policy if exists "coin_packages_public_read" on public.coin_packages;
create policy "coin_packages_public_read"
  on public.coin_packages for select using (is_active = true);

grant select, insert, update, delete on public.coin_wallets to service_role;
grant select, insert, update, delete on public.coin_packages to service_role;
grant select, insert, update, delete on public.coin_wallet_transactions to service_role;
grant select, insert, update, delete on public.coin_transfers to service_role;
grant select, insert, update, delete on public.membership_features to service_role;
grant select, insert, update, delete on public.membership_billing_logs to service_role;
grant select, insert, update, delete on public.subscription_events to service_role;
grant select, insert, update, delete on public.monetization_orders to service_role;
grant select, insert, update, delete on public.coin_analytics_daily to service_role;
