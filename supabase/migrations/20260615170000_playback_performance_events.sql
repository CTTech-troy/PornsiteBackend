-- Lightweight player telemetry for buffering, recovery, stream quality, and playback failures.

create table if not exists public.playback_performance_events (
  id uuid primary key default gen_random_uuid(),
  video_id text not null,
  user_id text,
  fingerprint text,
  event_type text not null check (
    event_type in (
      'play_start',
      'playing',
      'buffer_start',
      'buffer_end',
      'quality_change',
      'stream_retry',
      'playback_error',
      'ended',
      'watch_progress'
    )
  ),
  current_time numeric,
  duration numeric,
  quality_label text,
  buffering_ms integer,
  stream_type text,
  error_kind text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_playback_perf_video_created
  on public.playback_performance_events (video_id, created_at desc);

create index if not exists idx_playback_perf_user_created
  on public.playback_performance_events (user_id, created_at desc)
  where user_id is not null;

create index if not exists idx_playback_perf_fingerprint_created
  on public.playback_performance_events (fingerprint, created_at desc)
  where fingerprint is not null;

create index if not exists idx_video_play_history_user_updated
  on public.video_play_history (user_id, updated_at desc)
  where user_id is not null;

create index if not exists idx_video_play_history_session_updated
  on public.video_play_history (session_id, updated_at desc)
  where session_id is not null;

comment on table public.playback_performance_events is 'Player telemetry for buffering, quality switches, stream recovery, and playback failure monitoring.';
