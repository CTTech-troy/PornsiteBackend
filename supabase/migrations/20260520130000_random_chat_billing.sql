-- Random 1-on-1 video chat billing and usage history.
-- Applies server-authoritative 10 coin / 30 second billing with membership bypass.

create table if not exists public.random_chat_usage (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  user_id text not null,
  peer_user_id text,
  status text not null default 'active'
    check (status in ('active', 'ended', 'exhausted', 'abandoned', 'failed')),
  started_at timestamptz not null default now(),
  connected_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  billable_seconds integer not null default 0 check (billable_seconds >= 0),
  billing_interval_seconds integer not null default 30 check (billing_interval_seconds > 0),
  coin_cost_per_interval numeric not null default 10 check (coin_cost_per_interval >= 0),
  coins_spent numeric not null default 0 check (coins_spent >= 0),
  starting_balance numeric not null default 0 check (starting_balance >= 0),
  ending_balance numeric,
  membership_bypass boolean not null default false,
  billing_events jsonb not null default '[]'::jsonb,
  peer_logs jsonb not null default '{}'::jsonb,
  end_reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_random_chat_usage_room on public.random_chat_usage(room_id);
create index if not exists idx_random_chat_usage_user on public.random_chat_usage(user_id, created_at desc);
create index if not exists idx_random_chat_usage_status on public.random_chat_usage(status);

create or replace function public.spend_random_chat_coins(
  p_user_id text,
  p_amount numeric,
  p_room_id text,
  p_peer_user_id text default null,
  p_interval_index integer default 1
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
  v_new_balance numeric;
begin
  if p_user_id is null or length(trim(p_user_id)) = 0 then
    raise exception 'user_id required';
  end if;

  if p_amount <= 0 then
    raise exception 'coin amount must be positive';
  end if;

  insert into public.users (id)
  values (p_user_id)
  on conflict (id) do nothing;

  select coin_balance
    into v_balance
    from public.users
   where id = p_user_id
   for update;

  if v_balance is null or v_balance < p_amount then
    raise exception 'insufficient coins'
      using hint = 'coin_balance',
            detail = format('balance=%s required=%s', coalesce(v_balance, 0), p_amount);
  end if;

  update public.users
     set coin_balance = coin_balance - p_amount
   where id = p_user_id
  returning coin_balance into v_new_balance;

  insert into public.token_transactions (
    user_id,
    type,
    amount,
    status,
    metadata
  ) values (
    p_user_id,
    'adjustment',
    -p_amount,
    'completed',
    jsonb_build_object(
      'reason', 'random_chat_interval',
      'room_id', p_room_id,
      'peer_user_id', p_peer_user_id,
      'interval_index', p_interval_index,
      'interval_seconds', 30
    )
  );

  return v_new_balance;
end;
$$;

revoke all on function public.spend_random_chat_coins(text, numeric, text, text, integer) from public;
grant execute on function public.spend_random_chat_coins(text, numeric, text, text, integer) to service_role;

alter table public.random_chat_usage enable row level security;

drop policy if exists "random_chat_usage_service_only" on public.random_chat_usage;
create policy "random_chat_usage_service_only"
  on public.random_chat_usage for all
  using (false)
  with check (false);
