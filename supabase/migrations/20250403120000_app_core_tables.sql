-- App tables: live, wallets (wallet ledger), TikTok-style video, creator apps, media.
-- Run after 20250319120000_live_monetization.sql (public.users already exists).

create table if not exists public.lives (
  id uuid primary key default gen_random_uuid(),
  host_id text not null,
  host_display_name text,
  status text not null default 'created',
  viewers_count integer not null default 0,
  total_likes bigint not null default 0,
  total_gifts_amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

create unique index if not exists idx_lives_one_active_per_host
  on public.lives (host_id)
  where status in ('live', 'paused');

create table if not exists public.live_viewers (
  id uuid primary key default gen_random_uuid(),
  live_id uuid references public.lives(id) on delete cascade,
  user_id text not null,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  is_active boolean not null default true
);

create table if not exists public.live_comments (
  id uuid primary key default gen_random_uuid(),
  live_id uuid references public.lives(id) on delete cascade,
  user_id text,
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.live_gifts (
  id uuid primary key default gen_random_uuid(),
  live_id uuid references public.lives(id) on delete cascade,
  sender_id text,
  gift_type text not null,
  amount numeric(12,2) not null,
  created_at timestamptz not null default now()
);

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null unique,
  balance numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.creators (
  id uuid primary key default gen_random_uuid(),
  user_id text unique not null,
  display_name text,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  type text not null,
  amount numeric(14,2) not null,
  balance_after numeric(14,2) not null,
  meta jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.live_streams (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  title text,
  status text not null default 'active',
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create unique index if not exists idx_live_streams_one_active_per_user
  on public.live_streams (user_id)
  where status = 'active';

create table if not exists public.creator_applications (
  id uuid primary key,
  user_id text not null,
  data jsonb not null default '{}',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_creator_applications_user_id on public.creator_applications(user_id);
create index if not exists idx_creator_applications_status on public.creator_applications(status);

create table if not exists public.media (
  id text primary key,
  user_id text,
  bucket text,
  path text,
  url text,
  type text,
  title text,
  created_at timestamptz,
  extra jsonb default '{}'
);

create index if not exists idx_media_user_id on public.media(user_id);

create table if not exists public.tiktok_videos (
  video_id uuid primary key default gen_random_uuid(),
  user_id text not null,
  storage_url text not null,
  title text not null default '',
  description text default '',
  likes_count integer not null default 0 check (likes_count >= 0),
  views_count integer not null default 0 check (views_count >= 0),
  comments_count integer not null default 0 check (comments_count >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_tiktok_videos_user_id on public.tiktok_videos(user_id);
create index if not exists idx_tiktok_videos_created_at on public.tiktok_videos(created_at desc);

create table if not exists public.tiktok_video_likes (
  video_id uuid not null references public.tiktok_videos(video_id) on delete cascade,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (video_id, user_id)
);

create index if not exists idx_tiktok_video_likes_video_id on public.tiktok_video_likes(video_id);

create table if not exists public.tiktok_video_views (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.tiktok_videos(video_id) on delete cascade,
  user_id text,
  session_id text,
  created_at timestamptz not null default now(),
  constraint tiktok_views_user_or_session check (
    (user_id is not null and session_id is null) or
    (user_id is null and session_id is not null)
  )
);

create unique index if not exists idx_tiktok_video_views_unique_user
  on public.tiktok_video_views (video_id, user_id) where user_id is not null;
create unique index if not exists idx_tiktok_video_views_unique_session
  on public.tiktok_video_views (video_id, session_id) where session_id is not null;
create index if not exists idx_tiktok_video_views_video_id on public.tiktok_video_views(video_id);

create table if not exists public.tiktok_video_comments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.tiktok_videos(video_id) on delete cascade,
  user_id text not null,
  comment text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_tiktok_video_comments_video_id on public.tiktok_video_comments(video_id);

create table if not exists public.video_play_history (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.tiktok_videos(video_id) on delete cascade,
  user_id text,
  session_id text,
  has_seen_ad boolean not null default false,
  played_at timestamptz not null default now(),
  constraint play_history_user_or_session check (
    (user_id is not null and session_id is null) or
    (user_id is null and session_id is not null)
  )
);

create unique index if not exists idx_video_play_history_unique_user
  on public.video_play_history (video_id, user_id) where user_id is not null;
create unique index if not exists idx_video_play_history_unique_session
  on public.video_play_history (video_id, session_id) where session_id is not null;
create index if not exists idx_video_play_history_video_id on public.video_play_history(video_id);

create table if not exists public.video_ads (
  id uuid primary key default gen_random_uuid(),
  storage_url text not null,
  title text default 'Ad',
  skip_after_seconds integer not null default 5 check (skip_after_seconds >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_video_ads_active on public.video_ads(is_active) where is_active = true;

create table if not exists public.video_ad_impressions (
  id uuid primary key default gen_random_uuid(),
  ad_id uuid not null references public.video_ads(id) on delete cascade,
  video_id uuid not null references public.tiktok_videos(video_id) on delete cascade,
  user_id text,
  session_id text,
  skipped boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_video_ad_impressions_ad_id on public.video_ad_impressions(ad_id);
create index if not exists idx_video_ad_impressions_created on public.video_ad_impressions(created_at);
