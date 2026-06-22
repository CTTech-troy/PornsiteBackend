-- Platform Analytics & Business Intelligence
-- Raw visitor/session/watch/engagement facts plus daily rollups for fast admin dashboards.

create extension if not exists pgcrypto;

create table if not exists public.analytics_visitors (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  user_id text,
  ip_hash text,
  country text,
  region text,
  city text,
  device_type text,
  browser text,
  os text,
  referrer text,
  traffic_source text,
  landing_page text,
  visit_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint analytics_visitors_session_date_unique unique (session_id, visit_date)
);

create table if not exists public.analytics_sessions (
  session_id text primary key,
  user_id text,
  visitor_id uuid references public.analytics_visitors(id) on delete set null,
  start_time timestamptz not null default now(),
  last_activity timestamptz not null default now(),
  end_time timestamptz,
  duration_seconds integer not null default 0,
  pages_visited integer not null default 0,
  videos_watched integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.analytics_video_views (
  id uuid primary key default gen_random_uuid(),
  watch_id text not null,
  video_id text not null,
  user_id text,
  session_id text not null,
  watch_start timestamptz not null default now(),
  watch_end timestamptz,
  watch_duration integer not null default 0,
  completed boolean not null default false,
  progress_ratio numeric(6,4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint analytics_video_views_watch_unique unique (watch_id)
);

create table if not exists public.analytics_engagement (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (
    event_type in ('like', 'comment', 'share', 'favorite', 'subscription', 'creator_follow', 'creator_unfollow')
  ),
  video_id text,
  creator_id text,
  user_id text,
  session_id text,
  value integer not null default 1,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.analytics_daily_summary (
  date date primary key,
  visitors integer not null default 0,
  active_users integer not null default 0,
  views integer not null default 0,
  watch_time integer not null default 0,
  likes integer not null default 0,
  comments integer not null default 0,
  shares integer not null default 0,
  registrations integer not null default 0,
  sessions integer not null default 0,
  avg_session_seconds integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists idx_analytics_visitors_visit_date
  on public.analytics_visitors (visit_date desc);
create index if not exists idx_analytics_visitors_session
  on public.analytics_visitors (session_id);
create index if not exists idx_analytics_visitors_user_date
  on public.analytics_visitors (user_id, visit_date desc)
  where user_id is not null;
create index if not exists idx_analytics_visitors_source_date
  on public.analytics_visitors (traffic_source, visit_date desc);
create index if not exists idx_analytics_visitors_geo_date
  on public.analytics_visitors (country, region, city, visit_date desc);
create index if not exists idx_analytics_visitors_device_date
  on public.analytics_visitors (device_type, browser, os, visit_date desc);

create index if not exists idx_analytics_sessions_last_activity
  on public.analytics_sessions (last_activity desc);
create index if not exists idx_analytics_sessions_user_last_activity
  on public.analytics_sessions (user_id, last_activity desc)
  where user_id is not null;
create index if not exists idx_analytics_sessions_active
  on public.analytics_sessions (last_activity desc)
  where is_active = true;
create index if not exists idx_analytics_sessions_start_time
  on public.analytics_sessions (start_time desc);

create index if not exists idx_analytics_video_views_video_created
  on public.analytics_video_views (video_id, created_at desc);
create index if not exists idx_analytics_video_views_created
  on public.analytics_video_views (created_at desc);
create index if not exists idx_analytics_video_views_session
  on public.analytics_video_views (session_id, created_at desc);
create index if not exists idx_analytics_video_views_user_created
  on public.analytics_video_views (user_id, created_at desc)
  where user_id is not null;
create index if not exists idx_analytics_video_views_watch_start
  on public.analytics_video_views (watch_start desc);

create index if not exists idx_analytics_engagement_event_created
  on public.analytics_engagement (event_type, created_at desc);
create index if not exists idx_analytics_engagement_video_event_created
  on public.analytics_engagement (video_id, event_type, created_at desc)
  where video_id is not null;
create index if not exists idx_analytics_engagement_creator_event_created
  on public.analytics_engagement (creator_id, event_type, created_at desc)
  where creator_id is not null;
create index if not exists idx_analytics_daily_summary_date
  on public.analytics_daily_summary (date desc);

create or replace function public.increment_analytics_daily_summary(
  p_date date,
  p_visitors integer default 0,
  p_active_users integer default 0,
  p_views integer default 0,
  p_watch_time integer default 0,
  p_likes integer default 0,
  p_comments integer default 0,
  p_shares integer default 0,
  p_registrations integer default 0,
  p_sessions integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.analytics_daily_summary (
    date, visitors, active_users, views, watch_time, likes, comments, shares, registrations, sessions, updated_at
  )
  values (
    coalesce(p_date, current_date),
    greatest(coalesce(p_visitors, 0), 0),
    greatest(coalesce(p_active_users, 0), 0),
    greatest(coalesce(p_views, 0), 0),
    greatest(coalesce(p_watch_time, 0), 0),
    greatest(coalesce(p_likes, 0), 0),
    greatest(coalesce(p_comments, 0), 0),
    greatest(coalesce(p_shares, 0), 0),
    greatest(coalesce(p_registrations, 0), 0),
    greatest(coalesce(p_sessions, 0), 0),
    now()
  )
  on conflict (date) do update set
    visitors = public.analytics_daily_summary.visitors + excluded.visitors,
    active_users = greatest(public.analytics_daily_summary.active_users, excluded.active_users),
    views = public.analytics_daily_summary.views + excluded.views,
    watch_time = public.analytics_daily_summary.watch_time + excluded.watch_time,
    likes = public.analytics_daily_summary.likes + excluded.likes,
    comments = public.analytics_daily_summary.comments + excluded.comments,
    shares = public.analytics_daily_summary.shares + excluded.shares,
    registrations = public.analytics_daily_summary.registrations + excluded.registrations,
    sessions = public.analytics_daily_summary.sessions + excluded.sessions,
    updated_at = now();
end;
$$;

create or replace function public.refresh_analytics_daily_summary(
  p_from date default current_date - 30,
  p_to date default current_date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  delete from public.analytics_daily_summary
   where date between coalesce(p_from, current_date - 30) and coalesce(p_to, current_date);

  insert into public.analytics_daily_summary (
    date,
    visitors,
    active_users,
    views,
    watch_time,
    likes,
    comments,
    shares,
    registrations,
    sessions,
    avg_session_seconds,
    updated_at
  )
  select
    d.day::date as date,
    coalesce(v.visitors, 0) as visitors,
    coalesce(s.active_users, 0) as active_users,
    coalesce(w.views, 0) as views,
    coalesce(w.watch_time, 0) as watch_time,
    coalesce(e.likes, 0) as likes,
    coalesce(e.comments, 0) as comments,
    coalesce(e.shares, 0) as shares,
    coalesce(u.registrations, 0) as registrations,
    coalesce(s.sessions, 0) as sessions,
    coalesce(s.avg_session_seconds, 0) as avg_session_seconds,
    now() as updated_at
  from generate_series(coalesce(p_from, current_date - 30), coalesce(p_to, current_date), interval '1 day') d(day)
  left join (
    select visit_date, count(*)::integer visitors
    from public.analytics_visitors
    where visit_date between coalesce(p_from, current_date - 30) and coalesce(p_to, current_date)
    group by visit_date
  ) v on v.visit_date = d.day::date
  left join (
    select
      start_time::date as date,
      count(*)::integer sessions,
      (count(distinct user_id) filter (where user_id is not null))::integer active_users,
      coalesce(avg(nullif(duration_seconds, 0)), 0)::integer avg_session_seconds
    from public.analytics_sessions
    where start_time::date between coalesce(p_from, current_date - 30) and coalesce(p_to, current_date)
    group by start_time::date
  ) s on s.date = d.day::date
  left join (
    select
      created_at::date as date,
      count(*)::integer views,
      coalesce(sum(watch_duration), 0)::integer watch_time
    from public.analytics_video_views
    where created_at::date between coalesce(p_from, current_date - 30) and coalesce(p_to, current_date)
    group by created_at::date
  ) w on w.date = d.day::date
  left join (
    select
      created_at::date as date,
      (count(*) filter (where event_type = 'like'))::integer likes,
      (count(*) filter (where event_type = 'comment'))::integer comments,
      (count(*) filter (where event_type = 'share'))::integer shares
    from public.analytics_engagement
    where created_at::date between coalesce(p_from, current_date - 30) and coalesce(p_to, current_date)
    group by created_at::date
  ) e on e.date = d.day::date
  left join (
    select
      created_at::date as date,
      count(*)::integer registrations
    from public.users
    where created_at::date between coalesce(p_from, current_date - 30) and coalesce(p_to, current_date)
    group by created_at::date
  ) u on u.date = d.day::date;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

alter table public.analytics_visitors enable row level security;
alter table public.analytics_sessions enable row level security;
alter table public.analytics_video_views enable row level security;
alter table public.analytics_engagement enable row level security;
alter table public.analytics_daily_summary enable row level security;

grant select, insert, update, delete on public.analytics_visitors to service_role;
grant select, insert, update, delete on public.analytics_sessions to service_role;
grant select, insert, update, delete on public.analytics_video_views to service_role;
grant select, insert, update, delete on public.analytics_engagement to service_role;
grant select, insert, update, delete on public.analytics_daily_summary to service_role;
grant execute on function public.increment_analytics_daily_summary(date, integer, integer, integer, integer, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.refresh_analytics_daily_summary(date, date) to service_role;
