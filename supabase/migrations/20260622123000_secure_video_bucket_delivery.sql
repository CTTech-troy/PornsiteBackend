-- Lock platform video objects behind signed delivery.
-- The application now resolves playable video assets through
-- /api/videos/stream/:id, which creates short-lived signed URLs after access
-- checks. Thumbnails/images remain public through the images bucket.

update storage.buckets
set public = false
where id = 'videos';

create table if not exists public.playback_token_usage (
  token_hash text primary key,
  user_id text not null,
  video_id text not null,
  consumed_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_playback_token_usage_user_video
  on public.playback_token_usage (user_id, video_id, consumed_at desc);

create index if not exists idx_playback_token_usage_expires
  on public.playback_token_usage (expires_at);

alter table public.playback_token_usage enable row level security;

grant select, insert, delete on public.playback_token_usage to service_role;
