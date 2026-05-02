-- Create ad_campaigns table if it does not exist, then ensure all columns are present.
-- Safe to run multiple times.

create extension if not exists "uuid-ossp";

create table if not exists public.ad_campaigns (
  id           uuid        primary key default uuid_generate_v4(),
  name         text        not null default '',
  title        text,
  type         text        not null default 'image',
  image_url    text,
  video_url    text,
  click_url    text,
  description  text,
  placement    text        not null default 'homepage_banner',
  is_active    boolean     not null default true,
  impressions  bigint      not null default 0,
  clicks       bigint      not null default 0,
  budget_usd   numeric(12, 4) default 0,
  cpc          numeric(12, 6) default 0,
  revenue_usd  numeric(12, 6) default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Add any columns that might be missing on older installs
alter table public.ad_campaigns
  add column if not exists title        text,
  add column if not exists type         text not null default 'image',
  add column if not exists image_url    text,
  add column if not exists video_url    text,
  add column if not exists click_url    text,
  add column if not exists description  text,
  add column if not exists cpc          numeric(12, 6) default 0,
  add column if not exists revenue_usd  numeric(12, 6) default 0,
  add column if not exists budget_usd   numeric(12, 4) default 0;

-- Back-fill title from name for existing rows
update public.ad_campaigns set title = name where title is null and name <> '';

-- Replace the placement check constraint (drop old names first)
alter table public.ad_campaigns
  drop constraint if exists ad_campaigns_placement_check,
  drop constraint if exists check_placement;

alter table public.ad_campaigns
  add constraint ad_campaigns_placement_check check (
    placement in (
      'homepage_banner',
      'sidebar',
      'video_player',
      'creator_profile',
      'feed',
      'trending',
      'premium'
    )
  );

-- Performance indexes
create index if not exists idx_ad_campaigns_placement_active
  on public.ad_campaigns (placement, is_active);

create index if not exists idx_ad_campaigns_impressions
  on public.ad_campaigns (impressions asc);

-- Auto-update updated_at on row change
create or replace function public.set_ad_campaigns_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_ad_campaigns_updated_at on public.ad_campaigns;
create trigger trg_ad_campaigns_updated_at
  before update on public.ad_campaigns
  for each row execute function public.set_ad_campaigns_updated_at();

-- Enable RLS but allow service role full access
alter table public.ad_campaigns enable row level security;

drop policy if exists "service_role_all" on public.ad_campaigns;
create policy "service_role_all"
  on public.ad_campaigns
  as permissive for all
  to service_role
  using (true)
  with check (true);

-- Public read for active ads
drop policy if exists "public_read_active" on public.ad_campaigns;
create policy "public_read_active"
  on public.ad_campaigns
  as permissive for select
  to anon, authenticated
  using (is_active = true);
