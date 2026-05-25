-- Public API compatibility repair.
-- These columns are referenced by feed, search, creator ranking, and ad provider
-- services. They are added defensively so older Supabase projects can serve the
-- current backend without 42703 missing-column failures.

create table if not exists public.tiktok_videos (
  video_id text primary key,
  user_id text,
  title text default '',
  description text default '',
  main_orientation_category text default '',
  tags text[] default '{}',
  allow_people_to_comment boolean default true,
  storage_url text,
  stream_url text,
  thumbnail_url text,
  is_live boolean default true,
  likes_count integer default 0,
  comments_count integer default 0,
  views_count integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table if exists public.tiktok_videos
  add column if not exists status text,
  add column if not exists visibility text,
  add column if not exists duration_seconds integer,
  add column if not exists deleted_at timestamptz;

update public.tiktok_videos
   set status = case when coalesce(is_live, true) then 'published' else 'draft' end
 where status is null;

update public.tiktok_videos
   set visibility = 'public'
 where visibility is null;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'tiktok_videos'
       and column_name = 'duration'
  ) then
    execute 'update public.tiktok_videos set duration_seconds = duration where duration_seconds is null and duration is not null';
  end if;
end $$;

alter table if exists public.tiktok_videos
  alter column status set default 'published',
  alter column visibility set default 'public';

create index if not exists idx_tiktok_videos_public_feed
  on public.tiktok_videos (visibility, status, is_live, created_at desc)
  where deleted_at is null;

create index if not exists idx_tiktok_videos_user_public
  on public.tiktok_videos (user_id, visibility, status, is_live)
  where deleted_at is null;

create table if not exists public.ad_providers (
  id text primary key,
  slug text unique,
  name text not null,
  provider_type text not null default 'display',
  is_enabled boolean not null default true,
  is_maintenance boolean not null default false,
  priority integer not null default 100,
  script_url text,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.ad_providers
  add column if not exists provider_type text not null default 'display',
  add column if not exists type text;

update public.ad_providers
   set type = coalesce(nullif(type, ''), provider_type, 'display')
 where type is null or type = '';

alter table if exists public.ad_providers
  alter column type set default 'display';

do $$
begin
  perform public.notify_pgrst_reload_schema();
exception
  when undefined_function then
    notify pgrst, 'reload schema';
end $$;
