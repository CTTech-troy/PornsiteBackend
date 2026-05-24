-- VAST ad sessions, events, stream unlocks, and creator earnings ad source

create table if not exists public.vast_ad_sessions (
  id uuid primary key default gen_random_uuid(),
  video_id text not null,
  user_id text,
  creator_id text,
  fingerprint text,
  session_token_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'started', 'completed', 'skipped', 'failed', 'expired')),
  vast_tag_url text,
  skip_after_seconds int not null default 5,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_vast_ad_sessions_video on public.vast_ad_sessions (video_id, started_at desc);
create index if not exists idx_vast_ad_sessions_creator on public.vast_ad_sessions (creator_id, started_at desc);
create index if not exists idx_vast_ad_sessions_user on public.vast_ad_sessions (user_id, started_at desc);

create table if not exists public.vast_ad_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.vast_ad_sessions(id) on delete cascade,
  event_type text not null check (event_type in ('impression', 'started', 'complete', 'skip', 'error', 'click', 'watch_progress', 'unsupported')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, event_type)
);

create index if not exists idx_vast_ad_events_session on public.vast_ad_events (session_id, created_at);

create table if not exists public.video_ad_unlocks (
  id uuid primary key default gen_random_uuid(),
  video_id text not null,
  user_id text,
  fingerprint text,
  unlock_token_hash text not null,
  session_id uuid references public.vast_ad_sessions(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_video_ad_unlocks_lookup
  on public.video_ad_unlocks (video_id, user_id, fingerprint, expires_at desc);

create table if not exists public.video_play_history (
  id uuid primary key default gen_random_uuid(),
  video_id text not null,
  user_id text,
  session_id text,
  has_seen_ad boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists video_play_history_user_video
  on public.video_play_history (video_id, user_id)
  where user_id is not null;

create unique index if not exists video_play_history_session_video
  on public.video_play_history (video_id, session_id)
  where session_id is not null and user_id is null;

alter table if exists public.creator_earnings
  drop constraint if exists creator_earnings_source_check;

alter table if exists public.creator_earnings
  add constraint creator_earnings_source_check
  check (source in ('live_gifts', 'video_views', 'purchase', 'premium_video', 'ad', 'ad_impression', 'subscription', 'membership'));

create or replace function public.increment_ad_stat(p_ad_id uuid, p_field text)
returns void
language plpgsql
security definer
as $$
begin
  if p_field = 'impressions' then
    update public.video_ads set impressions = coalesce(impressions, 0) + 1 where id = p_ad_id;
  elsif p_field = 'clicks' then
    update public.video_ads set clicks = coalesce(clicks, 0) + 1 where id = p_ad_id;
  end if;
end;
$$;

comment on table public.vast_ad_sessions is 'Server-side VAST preroll ad playback sessions';
comment on table public.vast_ad_events is 'Idempotent ad lifecycle events per session';
comment on table public.video_ad_unlocks is 'Short-lived stream unlock tokens after validated ad views';
