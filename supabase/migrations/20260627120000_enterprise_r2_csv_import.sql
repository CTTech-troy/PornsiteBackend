create extension if not exists pgcrypto;

create table if not exists upload_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id text,
  status text not null default 'pending'
    check (status in ('pending', 'uploading', 'uploaded', 'processing', 'completed', 'failed', 'expired')),
  original_filename text not null,
  content_type text not null default 'text/csv',
  size_bytes bigint not null default 0,
  sha256 text,
  r2_bucket text not null,
  r2_key text not null unique,
  r2_upload_id text,
  part_size_bytes integer not null default 67108864,
  multipart_parts jsonb not null default '[]'::jsonb,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  upload_session_id uuid references upload_sessions(id) on delete set null,
  admin_id text,
  status text not null default 'queued'
    check (status in ('queued', 'counting', 'processing', 'completed', 'failed', 'cancelled')),
  total_rows bigint not null default 0,
  processed_rows bigint not null default 0,
  inserted_rows bigint not null default 0,
  updated_rows bigint not null default 0,
  duplicate_rows bigint not null default 0,
  failed_rows bigint not null default 0,
  bytes_processed bigint not null default 0,
  speed_rows_per_sec numeric not null default 0,
  eta_seconds integer not null default 0,
  checkpoint_row_number bigint not null default 0,
  attempt_count integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists failed_rows (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid not null references import_jobs(id) on delete cascade,
  row_number bigint,
  raw_row jsonb,
  cleaned_row jsonb,
  error_code text,
  error_message text,
  attempt_count integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists videos (
  id uuid primary key default gen_random_uuid(),
  video_url text not null,
  iframe_embed text,
  playback_type text not null default 'external_redirect'
    check (playback_type in ('internal', 'external_embed', 'external_redirect')),
  title text not null,
  duration integer,
  thumbnail_url text,
  tags text[] not null default '{}',
  actors text[] not null default '{}',
  views bigint not null default 0,
  category text,
  quality text,
  studio text,
  publish_date date,
  metadata jsonb not null default '{}'::jsonb,
  video_fingerprint text not null unique,
  import_job_id uuid references import_jobs(id) on delete set null,
  source_row_number bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_upload_sessions_status_created
  on upload_sessions(status, created_at desc);
create index if not exists idx_upload_sessions_expires
  on upload_sessions(expires_at)
  where status in ('pending', 'uploading');

create index if not exists idx_import_jobs_status_created
  on import_jobs(status, created_at);
create index if not exists idx_import_jobs_upload_session
  on import_jobs(upload_session_id);

create index if not exists idx_failed_rows_job_row
  on failed_rows(import_job_id, row_number);

create index if not exists idx_videos_import_job
  on videos(import_job_id);
create index if not exists idx_videos_created
  on videos(created_at desc);
create index if not exists idx_videos_publish_date
  on videos(publish_date desc);
create index if not exists idx_videos_category
  on videos(category);
create index if not exists idx_videos_tags
  on videos using gin(tags);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

notify pgrst, 'reload schema';

drop trigger if exists trg_upload_sessions_updated_at on upload_sessions;
create trigger trg_upload_sessions_updated_at
  before update on upload_sessions
  for each row execute function set_updated_at();

drop trigger if exists trg_import_jobs_updated_at on import_jobs;
create trigger trg_import_jobs_updated_at
  before update on import_jobs
  for each row execute function set_updated_at();

drop trigger if exists trg_videos_updated_at on videos;
create trigger trg_videos_updated_at
  before update on videos
  for each row execute function set_updated_at();

create or replace function upsert_videos_batch(p_rows jsonb, p_import_job_id uuid)
returns table(inserted_count integer, updated_count integer) as $$
declare
  v_inserted integer := 0;
  v_updated integer := 0;
begin
  with input_rows as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      video_url text,
      iframe_embed text,
      playback_type text,
      title text,
      duration integer,
      thumbnail_url text,
      tags text[],
      actors text[],
      views bigint,
      category text,
      quality text,
      studio text,
      publish_date date,
      metadata jsonb,
      video_fingerprint text,
      source_row_number bigint
    )
  ),
  upserted as (
    insert into videos (
      video_url, iframe_embed, playback_type, title, duration, thumbnail_url, tags, actors, views, category,
      quality, studio, publish_date, metadata, video_fingerprint, import_job_id,
      source_row_number
    )
    select
      video_url, iframe_embed, coalesce(playback_type, case when iframe_embed is not null and iframe_embed <> '' then 'external_embed' else 'external_redirect' end),
      title, duration, thumbnail_url, coalesce(tags, '{}'), coalesce(actors, '{}'),
      coalesce(views, 0), category, quality, studio, publish_date,
      coalesce(metadata, '{}'::jsonb), video_fingerprint, p_import_job_id, source_row_number
    from input_rows
    on conflict (video_fingerprint) do update set
      video_url = excluded.video_url,
      iframe_embed = excluded.iframe_embed,
      playback_type = excluded.playback_type,
      title = excluded.title,
      duration = excluded.duration,
      thumbnail_url = excluded.thumbnail_url,
      tags = excluded.tags,
      actors = excluded.actors,
      views = excluded.views,
      category = excluded.category,
      quality = excluded.quality,
      studio = excluded.studio,
      publish_date = excluded.publish_date,
      metadata = excluded.metadata,
      import_job_id = excluded.import_job_id,
      source_row_number = excluded.source_row_number,
      updated_at = now()
    returning (xmax = 0) as inserted
  )
  select
    count(*) filter (where inserted),
    count(*) filter (where not inserted)
  into v_inserted, v_updated
  from upserted;

  inserted_count := coalesce(v_inserted, 0);
  updated_count := coalesce(v_updated, 0);
  return next;
end;
$$ language plpgsql;
