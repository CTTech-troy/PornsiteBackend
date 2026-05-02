-- Full ads schema update: adds title, type, video_url, and extended placements.
-- Safe to run multiple times (all statements use IF NOT EXISTS / IF EXISTS guards).

-- Ensure ad_campaigns has all needed columns
alter table if exists public.ad_campaigns
  add column if not exists title       text,
  add column if not exists type        text not null default 'image',
  add column if not exists video_url   text,
  add column if not exists description text;

-- Back-fill title from name for existing rows
update public.ad_campaigns set title = name where title is null;

-- Widen the placement check constraint to cover all placements the platform uses.
-- Drop the old constraint first (ignore error if it doesn't exist).
alter table if exists public.ad_campaigns
  drop constraint if exists ad_campaigns_placement_check,
  drop constraint if exists check_placement;

alter table if exists public.ad_campaigns
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

-- Index for fast placement+active lookups (already exists in 011 but add if absent)
create index if not exists idx_ad_campaigns_placement_active
  on public.ad_campaigns (placement, is_active);

-- Index for fair rotation (least-served-first)
create index if not exists idx_ad_campaigns_impressions
  on public.ad_campaigns (impressions asc);
