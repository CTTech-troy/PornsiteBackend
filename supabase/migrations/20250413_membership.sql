-- =============================================================================
-- Membership plans, coin balance, and user subscription tracking
-- Depends on: 20250319120000_live_monetization.sql (public.users must exist)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Membership plan catalogue
-- ---------------------------------------------------------------------------
create table if not exists public.membership_plans (
  id            text          primary key,
  name          text          not null,
  description   text,
  coins         integer       not null default 0  check (coins >= 0),
  price_usd     numeric(10,2) not null             check (price_usd >= 0),
  price_ngn     numeric(14,2) not null             check (price_ngn >= 0),
  duration_days integer       not null default 30  check (duration_days > 0),
  is_active     boolean       not null default true
);

insert into public.membership_plans
  (id, name, description, coins, price_usd, price_ngn, duration_days)
values
  ('coins_30',  '30 Coins',          '30 coins + 30 days premium access',          30,   0.99,   1500.00, 30),
  ('coins_60',  '60 Coins',          '60 coins + 30 days premium access',           60,   1.99,   3000.00, 30),
  ('coins_120', '120 Coins',         '120 coins + 30 days premium access',         120,   5.99,   9000.00, 30),
  ('unlimited', 'Unlimited Monthly', 'Unlimited premium access for 30 days',         0,  50.00,  75000.00, 30)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Extend public.users with coin balance and active plan
-- ---------------------------------------------------------------------------
alter table public.users
  add column if not exists coin_balance       integer      not null default 0 check (coin_balance >= 0),
  add column if not exists active_plan        text         not null default 'basic',
  add column if not exists plan_expires_at    timestamptz,
  add column if not exists plan_grace_ends_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Membership purchase history
-- ---------------------------------------------------------------------------
create table if not exists public.user_memberships (
  id                uuid          primary key default gen_random_uuid(),
  user_id           text          not null references public.users(id) on delete restrict,
  plan_id           text          not null references public.membership_plans(id),
  coins_received    integer       not null default 0,
  status            text          not null default 'active',   -- active | grace | expired
  payment_reference text,
  payment_provider  text,                                       -- stripe | monnify
  amount_paid_usd   numeric(10,2),
  started_at        timestamptz   not null default now(),
  expires_at        timestamptz   not null,
  grace_ends_at     timestamptz   not null,
  created_at        timestamptz   not null default now()
);

create index if not exists idx_user_memberships_user_id on public.user_memberships(user_id);
create index if not exists idx_user_memberships_status  on public.user_memberships(status);
create index if not exists idx_user_memberships_expires on public.user_memberships(expires_at);

-- ---------------------------------------------------------------------------
-- 4. Atomic coin credit RPC (mirrors credit_wallet pattern)
-- ---------------------------------------------------------------------------
create or replace function public.add_coins(p_user_id text, p_amount integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_balance integer;
begin
  if p_amount <= 0 then
    raise exception 'coin amount must be positive';
  end if;

  -- Ensure user row exists
  insert into public.users (id) values (p_user_id) on conflict (id) do nothing;

  update public.users
     set coin_balance = coin_balance + p_amount
   where id = p_user_id
  returning coin_balance into v_new_balance;

  if not found then
    raise exception 'user not found: %', p_user_id;
  end if;

  return v_new_balance;
end;
$$;

revoke all on function public.add_coins(text, integer) from public;
grant execute on function public.add_coins(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Atomic coin debit RPC
-- ---------------------------------------------------------------------------
create or replace function public.spend_coins(p_user_id text, p_amount integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance     integer;
  v_new_balance integer;
begin
  if p_amount <= 0 then
    raise exception 'coin amount must be positive';
  end if;

  select coin_balance into v_balance
    from public.users
   where id = p_user_id
     for update;

  if not found then
    raise exception 'user not found: %', p_user_id;
  end if;

  if v_balance < p_amount then
    raise exception 'insufficient coins';
  end if;

  update public.users
     set coin_balance = coin_balance - p_amount
   where id = p_user_id
  returning coin_balance into v_new_balance;

  return v_new_balance;
end;
$$;

revoke all on function public.spend_coins(text, integer) from public;
grant execute on function public.spend_coins(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Row-level security
-- ---------------------------------------------------------------------------
alter table public.membership_plans enable row level security;
alter table public.user_memberships enable row level security;

drop policy if exists "plans_public_read" on public.membership_plans;
create policy "plans_public_read"
  on public.membership_plans for select using (is_active = true);

drop policy if exists "memberships_service_only" on public.user_memberships;
create policy "memberships_service_only"
  on public.user_memberships for all using (false) with check (false);
