-- Upgrade legacy gift_catalog (gift_type, label, price) to id, name, coin_cost, ...

create table if not exists public.gift_catalog (
  id text primary key,
  name text not null,
  coin_cost integer not null check (coin_cost > 0),
  emoji text,
  tone text,
  is_active boolean not null default true,
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
  add column if not exists is_active boolean not null default true,
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
exception
  when duplicate_object then null;
end $$;

insert into public.gift_catalog (id, name, coin_cost, tone, sort_order)
values
  ('rose', 'Rose', 30, 'from-rose-500 to-red-500', 1),
  ('spark', 'Spark', 75, 'from-amber-400 to-orange-500', 2),
  ('halo', 'Halo', 120, 'from-cyan-400 to-blue-500', 3),
  ('crown', 'Crown', 300, 'from-fuchsia-500 to-pink-500', 4),
  ('diamond', 'Diamond', 600, 'from-sky-400 to-indigo-500', 5)
on conflict (id) do update set
  name = excluded.name,
  coin_cost = excluded.coin_cost,
  tone = excluded.tone,
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();

grant select on public.gift_catalog to service_role;
grant insert, update, delete on public.gift_catalog to service_role;
grant select on public.gift_catalog to anon, authenticated;

alter table public.gift_catalog enable row level security;

drop policy if exists gift_catalog_public_read on public.gift_catalog;
create policy gift_catalog_public_read on public.gift_catalog
  for select using (is_active = true);
