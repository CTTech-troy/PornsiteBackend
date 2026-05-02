-- creator_earnings: stores USD earnings per creator
create table if not exists public.creator_earnings (
  id          uuid primary key default gen_random_uuid(),
  creator_id  text not null,
  amount_usd  numeric(12,6) not null default 0,
  source      text not null check (source in ('live_gifts', 'video_views')),
  source_id   text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_creator_earnings_creator_id on public.creator_earnings(creator_id);
create index if not exists idx_creator_earnings_source_id  on public.creator_earnings(source, source_id);

-- platform_settings: admin-configurable key/value pairs
create table if not exists public.platform_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- seed initial NGN/USD rate (can be overridden via POST /api/earnings/rate)
insert into platform_settings (key, value)
values ('ngn_to_usd_rate', '1600')
on conflict (key) do nothing;
