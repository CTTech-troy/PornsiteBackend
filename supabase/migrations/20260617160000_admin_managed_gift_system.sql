-- Admin-managed gifts only.
-- Legacy seeded/static gifts are disabled, and public reads only expose gifts
-- explicitly created or edited through the admin catalog.

create extension if not exists pgcrypto;

create table if not exists public.gift_catalog (
  id text primary key,
  name text not null,
  coin_cost integer not null check (coin_cost > 0),
  emoji text,
  tone text,
  image_url text,
  animation_type text not null default 'float',
  category text not null default 'general',
  rarity text not null default 'common',
  is_active boolean not null default true,
  admin_created boolean not null default false,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gift_catalog' and column_name = 'gift_type'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gift_catalog' and column_name = 'id'
  ) then
    alter table public.gift_catalog rename column gift_type to id;
    alter table public.gift_catalog rename column label to name;
    alter table public.gift_catalog rename column price to coin_cost;
  end if;
end $$;

alter table public.gift_catalog
  add column if not exists emoji text,
  add column if not exists tone text,
  add column if not exists image_url text,
  add column if not exists animation_type text not null default 'float',
  add column if not exists category text not null default 'general',
  add column if not exists rarity text not null default 'common',
  add column if not exists is_active boolean not null default true,
  add column if not exists admin_created boolean not null default false,
  add column if not exists sort_order integer not null default 0,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'gift_catalog'
      and column_name = 'coin_cost'
      and data_type in ('numeric', 'double precision', 'real')
  ) then
    alter table public.gift_catalog
      alter column coin_cost type integer using greatest(1, round(coin_cost)::integer);
  end if;
end $$;

alter table public.gift_catalog alter column name set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'gift_catalog_coin_cost_check'
      and conrelid = 'public.gift_catalog'::regclass
  ) then
    alter table public.gift_catalog
      add constraint gift_catalog_coin_cost_check check (coin_cost > 0);
  end if;
exception when duplicate_object then null;
end $$;

-- Preserve probable admin-created custom gifts, but disable known legacy/static seeds.
update public.gift_catalog
   set admin_created = true,
       metadata = coalesce(metadata, '{}'::jsonb) || '{"adminCreated": true, "migrationInferred": true}'::jsonb,
       updated_at = now()
 where id not in ('rose', 'heart', 'star', 'spark', 'halo', 'crown', 'diamond')
   and admin_created = false;

update public.gift_catalog
   set is_active = false,
       admin_created = false,
       metadata = coalesce(metadata, '{}'::jsonb) || '{"legacyStaticGiftDisabled": true}'::jsonb,
       updated_at = now()
 where id in ('rose', 'heart', 'star', 'spark', 'halo', 'crown', 'diamond')
   and admin_created = false;

alter table if exists public.live_gifts
  add column if not exists token_price numeric,
  add column if not exists gift_emoji text,
  add column if not exists gift_name text,
  add column if not exists gift_image_url text,
  add column if not exists gift_animation_type text,
  add column if not exists gift_category text,
  add column if not exists gift_rarity text,
  add column if not exists sender_name text,
  add column if not exists sender_balance_after numeric,
  add column if not exists creator_amount numeric,
  add column if not exists platform_amount numeric,
  add column if not exists wallet_transfer_id uuid,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists gift_catalog_public_idx
  on public.gift_catalog(is_active, admin_created, sort_order);

create index if not exists live_gifts_type_created_idx
  on public.live_gifts(gift_type, created_at desc);

alter table public.gift_catalog enable row level security;

drop policy if exists gift_catalog_read on public.gift_catalog;
drop policy if exists gift_catalog_public_read on public.gift_catalog;
create policy gift_catalog_public_read on public.gift_catalog
  for select using (is_active = true and admin_created = true);

grant select on public.gift_catalog to anon, authenticated;
grant select, insert, update, delete on public.gift_catalog to service_role;

create or replace function public.send_catalog_gift(
  p_sender_id text,
  p_creator_id text,
  p_stream_id text,
  p_gift_id text,
  p_sender_name text default null,
  p_idempotency_key text default null
)
returns table(
  sender_balance numeric,
  recipient_balance numeric,
  transfer_id uuid,
  sender_tx_id uuid,
  recipient_tx_id uuid,
  live_gift_id uuid,
  gift_id text,
  gift_name text,
  gift_image_url text,
  gift_emoji text,
  gift_animation_type text,
  gift_category text,
  gift_rarity text,
  coin_cost numeric,
  creator_amount numeric,
  platform_amount numeric,
  total_gifts_amount numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender public.coin_wallets%rowtype;
  v_recipient public.coin_wallets%rowtype;
  v_gift public.gift_catalog%rowtype;
  v_live public.lives%rowtype;
  v_sender_after numeric;
  v_recipient_after numeric;
  v_transfer uuid;
  v_sender_tx uuid;
  v_recipient_tx uuid;
  v_live_gift uuid;
  v_creator_percent numeric := 70;
  v_creator_amount numeric;
  v_platform_amount numeric;
  v_total numeric := null;
  v_reference text;
  v_metadata jsonb;
begin
  if p_sender_id is null or p_creator_id is null or p_stream_id is null or p_gift_id is null then
    raise exception 'gift_request_invalid';
  end if;
  if p_sender_id = p_creator_id then
    raise exception 'cannot_gift_self';
  end if;

  select * into v_gift
    from public.gift_catalog
   where id = p_gift_id
     and is_active = true
     and admin_created = true
   limit 1;

  if not found then
    raise exception 'gift_not_found';
  end if;

  begin
    select case
      when value ~ '^[0-9]+(\.[0-9]+)?$' then value::numeric
      else null
    end into v_creator_percent
      from public.platform_settings
     where key = 'live_gift_creator_percent'
     limit 1;
  exception when others then
    v_creator_percent := 70;
  end;
  v_creator_percent := least(100, greatest(0, coalesce(v_creator_percent, 70)));
  v_creator_amount := round(v_gift.coin_cost::numeric * (v_creator_percent / 100), 2);
  v_platform_amount := v_gift.coin_cost::numeric - v_creator_amount;

  v_reference := coalesce(p_idempotency_key, 'gift:' || p_sender_id || ':' || p_creator_id || ':' || p_stream_id || ':' || p_gift_id);

  select id into v_transfer
    from public.coin_transfers
   where reference = v_reference
   limit 1;
  if found then
    select balance into sender_balance from public.coin_wallets where user_id = p_sender_id;
    select balance into recipient_balance from public.coin_wallets where user_id = p_creator_id;
    transfer_id := v_transfer;
    gift_id := v_gift.id;
    gift_name := v_gift.name;
    gift_image_url := v_gift.image_url;
    gift_emoji := v_gift.emoji;
    gift_animation_type := v_gift.animation_type;
    gift_category := v_gift.category;
    gift_rarity := v_gift.rarity;
    coin_cost := v_gift.coin_cost;
    creator_amount := v_creator_amount;
    platform_amount := v_platform_amount;
    total_gifts_amount := null;
    return next;
    return;
  end if;

  perform public.ensure_coin_wallet(p_sender_id);
  perform public.ensure_coin_wallet(p_creator_id);

  select * into v_sender
    from public.coin_wallets
   where user_id = p_sender_id
   for update;

  if v_sender.balance < v_gift.coin_cost then
    raise exception 'insufficient_coins'
      using hint = 'coin_balance',
            detail = format('balance=%s required=%s', v_sender.balance, v_gift.coin_cost);
  end if;

  select * into v_recipient
    from public.coin_wallets
   where user_id = p_creator_id
   for update;

  v_metadata := jsonb_build_object(
    'gift_id', v_gift.id,
    'gift_name', v_gift.name,
    'gift_image_url', v_gift.image_url,
    'gift_animation_type', v_gift.animation_type,
    'gift_category', v_gift.category,
    'gift_rarity', v_gift.rarity,
    'stream_id', p_stream_id,
    'creator_id', p_creator_id,
    'sender_name', p_sender_name,
    'official_coin_cost', v_gift.coin_cost,
    'creator_amount', v_creator_amount,
    'platform_amount', v_platform_amount
  );

  insert into public.coin_transfers (sender_id, recipient_id, amount, reference, metadata)
  values (p_sender_id, p_creator_id, v_gift.coin_cost, v_reference, v_metadata)
  returning id into v_transfer;

  update public.coin_wallets
     set balance = balance - v_gift.coin_cost,
         lifetime_spent = lifetime_spent + v_gift.coin_cost,
         updated_at = now()
   where id = v_sender.id
   returning balance into v_sender_after;

  update public.users set coin_balance = v_sender_after where id = p_sender_id;

  update public.coin_wallets
     set balance = balance + v_creator_amount,
         lifetime_received = lifetime_received + v_creator_amount,
         updated_at = now()
   where id = v_recipient.id
   returning balance into v_recipient_after;

  update public.users set coin_balance = v_recipient_after where id = p_creator_id;

  insert into public.coin_wallet_transactions (
    wallet_id, user_id, type, amount, balance_before, balance_after,
    reference, related_user_id, idempotency_key, source_type, source_id, metadata
  )
  values (
    v_sender.id, p_sender_id, 'gift_sent', -v_gift.coin_cost, v_sender.balance, v_sender_after,
    v_reference || ':out', p_creator_id, v_reference || ':out', 'gift', p_stream_id, v_metadata
  )
  returning id into v_sender_tx;

  insert into public.coin_wallet_transactions (
    wallet_id, user_id, type, amount, balance_before, balance_after,
    reference, related_user_id, idempotency_key, source_type, source_id, metadata
  )
  values (
    v_recipient.id, p_creator_id, 'gift_received', v_creator_amount, v_recipient.balance, v_recipient_after,
    v_reference || ':in', p_sender_id, v_reference || ':in', 'gift', p_stream_id, v_metadata
  )
  returning id into v_recipient_tx;

  select * into v_live
    from public.lives
   where id::text = p_stream_id
   limit 1;

  if found then
    insert into public.live_gifts (
      live_id,
      sender_id,
      gift_type,
      gift_name,
      gift_emoji,
      gift_image_url,
      gift_animation_type,
      gift_category,
      gift_rarity,
      sender_name,
      amount,
      token_price,
      sender_balance_after,
      creator_amount,
      platform_amount,
      wallet_transfer_id,
      metadata
    )
    values (
      v_live.id,
      p_sender_id,
      v_gift.id,
      v_gift.name,
      v_gift.emoji,
      v_gift.image_url,
      v_gift.animation_type,
      v_gift.category,
      v_gift.rarity,
      p_sender_name,
      v_gift.coin_cost,
      v_gift.coin_cost,
      v_sender_after,
      v_creator_amount,
      v_platform_amount,
      v_transfer,
      v_metadata
    )
    returning id into v_live_gift;

    update public.lives
       set total_gifts_amount = coalesce(total_gifts_amount, 0) + v_gift.coin_cost
     where id = v_live.id
     returning total_gifts_amount into v_total;
  end if;

  sender_balance := v_sender_after;
  recipient_balance := v_recipient_after;
  transfer_id := v_transfer;
  sender_tx_id := v_sender_tx;
  recipient_tx_id := v_recipient_tx;
  live_gift_id := v_live_gift;
  gift_id := v_gift.id;
  gift_name := v_gift.name;
  gift_image_url := v_gift.image_url;
  gift_emoji := v_gift.emoji;
  gift_animation_type := v_gift.animation_type;
  gift_category := v_gift.category;
  gift_rarity := v_gift.rarity;
  coin_cost := v_gift.coin_cost;
  creator_amount := v_creator_amount;
  platform_amount := v_platform_amount;
  total_gifts_amount := v_total;
  return next;
end;
$$;

revoke all on function public.send_catalog_gift(text, text, text, text, text, text) from public;
grant execute on function public.send_catalog_gift(text, text, text, text, text, text) to service_role;
