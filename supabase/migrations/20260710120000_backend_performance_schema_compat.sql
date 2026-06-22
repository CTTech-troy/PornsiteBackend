-- Backend performance/schema compatibility repair.
-- Apply this after the analytics BI migration in projects where the live
-- Supabase schema has drifted behind the current backend code.

alter table if exists public.tiktok_videos
  add column if not exists creator_id text,
  add column if not exists status text,
  add column if not exists visibility text,
  add column if not exists thumbnail_url text,
  add column if not exists duration_seconds integer,
  add column if not exists duration integer,
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists main_orientation_category text,
  add column if not exists tags text[] default '{}',
  add column if not exists allow_people_to_comment boolean default true,
  add column if not exists stream_url text,
  add column if not exists creator_display_name text,
  add column if not exists creator_avatar_url text,
  add column if not exists consent_given boolean default false,
  add column if not exists is_premium_content boolean default false,
  add column if not exists token_price numeric default 0,
  add column if not exists coin_price numeric default 0,
  add column if not exists access_type text default 'free',
  add column if not exists premium_visibility text,
  add column if not exists requires_membership boolean default false,
  add column if not exists subscription_access boolean default false,
  add column if not exists official_company_content boolean default false,
  add column if not exists playable boolean default true,
  add column if not exists source_type text,
  add column if not exists embed_allowed boolean default true,
  add column if not exists validation_status text,
  add column if not exists playback_url text;

update public.tiktok_videos
   set creator_id = coalesce(creator_id, user_id)
 where creator_id is null
   and user_id is not null;

update public.tiktok_videos
   set status = case when coalesce(is_live, true) then 'published' else 'draft' end
 where status is null;

update public.tiktok_videos
   set visibility = 'public'
 where visibility is null;

update public.tiktok_videos
   set stream_url = storage_url
 where stream_url is null
   and storage_url is not null;

alter table if exists public.tiktok_videos
  alter column status set default 'published',
  alter column visibility set default 'public';

alter table if exists public.media
  add column if not exists media_id text,
  add column if not exists media_type text,
  add column if not exists status text,
  add column if not exists visibility text,
  add column if not exists storage_url text,
  add column if not exists stream_url text,
  add column if not exists video_url text,
  add column if not exists public_url text,
  add column if not exists thumbnail_url text,
  add column if not exists thumbnail text,
  add column if not exists poster_url text,
  add column if not exists poster text,
  add column if not exists content_type text,
  add column if not exists mime_type text,
  add column if not exists description text,
  add column if not exists main_orientation_category text,
  add column if not exists category text,
  add column if not exists tags text[] default '{}',
  add column if not exists duration_seconds integer,
  add column if not exists duration integer,
  add column if not exists creator_display_name text,
  add column if not exists creator_avatar_url text,
  add column if not exists is_premium_content boolean default false,
  add column if not exists token_price numeric default 0,
  add column if not exists access_type text default 'free',
  add column if not exists premium_visibility text,
  add column if not exists requires_membership boolean default false,
  add column if not exists subscription_access boolean default false,
  add column if not exists likes_count integer default 0,
  add column if not exists comments_count integer default 0,
  add column if not exists views_count integer default 0,
  add column if not exists views integer default 0,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists is_live boolean default true;

update public.media
   set media_id = coalesce(media_id, id)
 where media_id is null;

update public.media
   set media_type = coalesce(media_type, type)
 where media_type is null
   and type is not null;

update public.media
   set storage_url = coalesce(storage_url, url),
       stream_url = coalesce(stream_url, url),
       video_url = coalesce(video_url, url),
       public_url = coalesce(public_url, url)
 where url is not null;

update public.media
   set status = 'published'
 where status is null;

update public.media
   set visibility = 'public'
 where visibility is null;

alter table if exists public.media
  alter column status set default 'published',
  alter column visibility set default 'public';

alter table if exists public.videos
  add column if not exists deleted_at timestamptz;

create table if not exists public.playback_performance_events (
  id uuid primary key default gen_random_uuid(),
  video_id text not null,
  user_id text,
  fingerprint text,
  event_type text not null, 
  "current_time" numeric,
  duration numeric,
  quality_label text,
  buffering_ms integer,
  stream_type text,
  error_kind text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_tiktok_videos_public_feed_perf
  on public.tiktok_videos (visibility, status, is_live, created_at desc)
  where deleted_at is null;

create index if not exists idx_tiktok_videos_creator_created_perf
  on public.tiktok_videos (creator_id, created_at desc)
  where creator_id is not null;

create index if not exists idx_tiktok_videos_user_created_perf
  on public.tiktok_videos (user_id, created_at desc)
  where user_id is not null;

create index if not exists idx_media_media_id_perf
  on public.media (media_id)
  where media_id is not null;

create index if not exists idx_media_public_feed_perf
  on public.media (visibility, status, type, created_at desc);

create index if not exists idx_videos_deleted_at_perf
  on public.videos (deleted_at);

create index if not exists idx_analytics_sessions_last_activity_perf
  on public.analytics_sessions (last_activity desc);

create index if not exists idx_analytics_sessions_start_time_perf
  on public.analytics_sessions (start_time desc);

create index if not exists idx_playback_performance_video_created_perf
  on public.playback_performance_events (video_id, created_at desc);

create index if not exists idx_playback_performance_created_perf
  on public.playback_performance_events (created_at desc);

do $$
begin
  perform public.notify_pgrst_reload_schema();
exception
  when undefined_function then
    null;
end $$;
