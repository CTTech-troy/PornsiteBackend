-- Live monetization (Edge Functions + RPC). Wallet ledger uses public.transactions in a separate migration.
-- Donation rows live in stream_donations (not public.transactions) to avoid clashing with wallet transactions.

create table if not exists public.users (
  id text primary key,
  balance numeric(18, 2) not null default 0 check (balance >= 0),
  username text,
  creator boolean default false,
  verified text default 'none',
  creator_application jsonb default '{}',
  followers integer not null default 0,
  created_at timestamptz default now()
);

create table if not exists public.streams (
  id text primary key,
  creator_id text not null references public.users (id) on delete restrict,
  total_earned numeric(18, 2) not null default 0 check (total_earned >= 0),
  created_at timestamptz not null default now()
);

create index if not exists streams_creator_idx on public.streams (creator_id);

create table if not exists public.stream_donations (
  id uuid primary key default gen_random_uuid(),
  stream_id text not null references public.streams (id) on delete cascade,
  sender_id text not null references public.users (id) on delete restrict,
  creator_id text not null references public.users (id) on delete restrict,
  amount numeric(18, 2) not null check (amount > 0),
  platform_fee numeric(18, 2) not null check (platform_fee >= 0),
  creator_earnings numeric(18, 2) not null check (creator_earnings >= 0),
  gift_type text,
  created_at timestamptz not null default now()
);

create index if not exists stream_donations_stream_idx on public.stream_donations (stream_id);
create index if not exists stream_donations_stream_created_idx on public.stream_donations (stream_id, created_at desc);

create table if not exists public.gift_catalog (
  gift_type text primary key,
  label text not null,
  price numeric(18, 2) not null check (price > 0)
);

insert into public.gift_catalog (gift_type, label, price) values
  ('rose', 'Rose', 100),
  ('heart', 'Heart', 500),
  ('star', 'Star', 1000),
  ('crown', 'Crown', 5000)
on conflict (gift_type) do nothing;

create or replace function public.process_live_donation(
  p_stream_id text,
  p_sender_id text,
  p_creator_id text,
  p_amount numeric,
  p_gift_type text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator_id text;
  v_platform_fee numeric(18, 2);
  v_creator_earnings numeric(18, 2);
  v_sender_bal numeric(18, 2);
  v_tx_id uuid;
begin
  if p_stream_id is null or length(trim(p_stream_id)) = 0 then
    raise exception 'invalid stream_id';
  end if;
  if p_sender_id is null or p_creator_id is null then
    raise exception 'invalid user ids';
  end if;
  if p_sender_id = p_creator_id then
    raise exception 'cannot donate to yourself';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;

  insert into public.users (id) values (p_sender_id) on conflict (id) do nothing;
  insert into public.users (id) values (p_creator_id) on conflict (id) do nothing;

  insert into public.streams (id, creator_id) values (p_stream_id, p_creator_id)
  on conflict (id) do nothing;

  select s.creator_id into v_creator_id from public.streams s where s.id = p_stream_id for update;
  if not found then
    raise exception 'stream not found';
  end if;
  if v_creator_id <> p_creator_id then
    raise exception 'creator mismatch';
  end if;

  v_platform_fee := round(p_amount * 0.5, 2);
  v_creator_earnings := p_amount - v_platform_fee;

  select u.balance into v_sender_bal from public.users u where u.id = p_sender_id for update;
  if not found then
    raise exception 'sender not found';
  end if;
  if v_sender_bal < p_amount then
    raise exception 'insufficient balance';
  end if;

  update public.users set balance = balance - p_amount where id = p_sender_id;
  update public.users set balance = balance + v_creator_earnings where id = p_creator_id;
  update public.streams set total_earned = total_earned + v_creator_earnings where id = p_stream_id;

  insert into public.stream_donations (
    stream_id, sender_id, creator_id, amount, platform_fee, creator_earnings, gift_type
  ) values (
    p_stream_id, p_sender_id, p_creator_id, p_amount, v_platform_fee, v_creator_earnings, p_gift_type
  )
  returning id into v_tx_id;

  return jsonb_build_object(
    'ok', true,
    'transaction_id', v_tx_id,
    'platform_fee', v_platform_fee,
    'creator_earnings', v_creator_earnings,
    'stream_id', p_stream_id,
    'creator_id', p_creator_id,
    'sender_id', p_sender_id,
    'amount', p_amount,
    'gift_type', p_gift_type
  );
end;
$$;

revoke all on function public.process_live_donation(text, text, text, numeric, text) from public;
grant execute on function public.process_live_donation(text, text, text, numeric, text) to service_role;

alter table public.users enable row level security;
alter table public.streams enable row level security;
alter table public.stream_donations enable row level security;
alter table public.gift_catalog enable row level security;

drop policy if exists "users_no_client_write" on public.users;
create policy "users_no_client_write" on public.users for all using (false) with check (false);

drop policy if exists "streams_no_client_write" on public.streams;
create policy "streams_no_client_write" on public.streams for all using (false) with check (false);

drop policy if exists "stream_donations_no_client_write" on public.stream_donations;
create policy "stream_donations_no_client_write" on public.stream_donations for all using (false) with check (false);

drop policy if exists "gift_catalog_read" on public.gift_catalog;
create policy "gift_catalog_read" on public.gift_catalog for select using (true);

create or replace function public.get_stream_leaderboard(p_stream_id text, p_limit int default 20)
returns table (sender_id text, total_sent numeric, donation_count bigint)
language sql
security definer
set search_path = public
as $$
  select t.sender_id, sum(t.amount)::numeric as total_sent, count(*)::bigint as donation_count
  from public.stream_donations t
  where t.stream_id = p_stream_id
  group by t.sender_id
  order by sum(t.amount) desc
  limit greatest(1, least(p_limit, 100))
$$;

revoke all on function public.get_stream_leaderboard(text, int) from public;
grant execute on function public.get_stream_leaderboard(text, int) to service_role;
