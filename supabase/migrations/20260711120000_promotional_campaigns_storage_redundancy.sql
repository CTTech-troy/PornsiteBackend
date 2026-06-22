create extension if not exists pgcrypto;

create table if not exists public.promotional_campaigns (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  image_url text,
  video_url text,
  cta_text text,
  cta_link text,
  priority integer not null default 0,
  start_date timestamptz,
  end_date timestamptz,
  active boolean not null default true,
  targeting jsonb not null default '{}'::jsonb,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  unique_viewers bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.promotional_campaigns add column if not exists title text;
alter table public.promotional_campaigns add column if not exists description text;
alter table public.promotional_campaigns add column if not exists image_url text;
alter table public.promotional_campaigns add column if not exists video_url text;
alter table public.promotional_campaigns add column if not exists cta_text text;
alter table public.promotional_campaigns add column if not exists cta_link text;
alter table public.promotional_campaigns add column if not exists priority integer not null default 0;
alter table public.promotional_campaigns add column if not exists start_date timestamptz;
alter table public.promotional_campaigns add column if not exists end_date timestamptz;
alter table public.promotional_campaigns add column if not exists active boolean not null default true;
alter table public.promotional_campaigns add column if not exists targeting jsonb not null default '{}'::jsonb;
alter table public.promotional_campaigns add column if not exists impressions bigint not null default 0;
alter table public.promotional_campaigns add column if not exists clicks bigint not null default 0;
alter table public.promotional_campaigns add column if not exists unique_viewers bigint not null default 0;
alter table public.promotional_campaigns add column if not exists created_at timestamptz not null default now();
alter table public.promotional_campaigns add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_promotional_campaigns_active_schedule
  on public.promotional_campaigns (active, priority desc, start_date, end_date);

create index if not exists idx_promotional_campaigns_created_at
  on public.promotional_campaigns (created_at desc);

create table if not exists public.promotional_campaign_events (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.promotional_campaigns(id) on delete cascade,
  event_type text not null check (event_type in ('impression', 'click', 'close')),
  viewer_hash text,
  user_id text,
  session_id text,
  ip_hash text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_promotional_campaign_events_campaign_created
  on public.promotional_campaign_events (campaign_id, created_at desc);

create index if not exists idx_promotional_campaign_events_type_created
  on public.promotional_campaign_events (event_type, created_at desc);

create index if not exists idx_promotional_campaign_events_unique_viewer
  on public.promotional_campaign_events (campaign_id, viewer_hash)
  where event_type = 'impression' and viewer_hash is not null;

create table if not exists public.media_storage_replicas (
  id uuid primary key default gen_random_uuid(),
  source_table text,
  source_id text,
  media_type text not null,
  primary_bucket text,
  primary_path text,
  primary_url text,
  backup_bucket text,
  backup_key text,
  backup_url text,
  storage_provider text not null default 'supabase',
  replication_status text not null default 'pending',
  integrity_status text not null default 'pending',
  content_type text,
  content_length bigint,
  checksum_sha256 text,
  attempts integer not null default 0,
  last_error text,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.media_storage_replicas add column if not exists source_table text;
alter table public.media_storage_replicas add column if not exists source_id text;
alter table public.media_storage_replicas add column if not exists media_type text not null default 'asset';
alter table public.media_storage_replicas add column if not exists primary_bucket text;
alter table public.media_storage_replicas add column if not exists primary_path text;
alter table public.media_storage_replicas add column if not exists primary_url text;
alter table public.media_storage_replicas add column if not exists backup_bucket text;
alter table public.media_storage_replicas add column if not exists backup_key text;
alter table public.media_storage_replicas add column if not exists backup_url text;
alter table public.media_storage_replicas add column if not exists storage_provider text not null default 'supabase';
alter table public.media_storage_replicas add column if not exists replication_status text not null default 'pending';
alter table public.media_storage_replicas add column if not exists integrity_status text not null default 'pending';
alter table public.media_storage_replicas add column if not exists content_type text;
alter table public.media_storage_replicas add column if not exists content_length bigint;
alter table public.media_storage_replicas add column if not exists checksum_sha256 text;
alter table public.media_storage_replicas add column if not exists attempts integer not null default 0;
alter table public.media_storage_replicas add column if not exists last_error text;
alter table public.media_storage_replicas add column if not exists last_sync_at timestamptz;
alter table public.media_storage_replicas add column if not exists created_at timestamptz not null default now();
alter table public.media_storage_replicas add column if not exists updated_at timestamptz not null default now();

create unique index if not exists idx_media_storage_replicas_identity
  on public.media_storage_replicas (
    coalesce(source_table, ''),
    coalesce(source_id, ''),
    media_type,
    coalesce(primary_bucket, ''),
    coalesce(primary_path, '')
  );

create index if not exists idx_media_storage_replicas_status
  on public.media_storage_replicas (replication_status, updated_at desc);

create index if not exists idx_media_storage_replicas_source
  on public.media_storage_replicas (source_table, source_id);

create table if not exists public.storage_replication_logs (
  id uuid primary key default gen_random_uuid(),
  replica_id uuid references public.media_storage_replicas(id) on delete set null,
  action text not null,
  status text not null,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_storage_replication_logs_created
  on public.storage_replication_logs (created_at desc);

create index if not exists idx_storage_replication_logs_replica
  on public.storage_replication_logs (replica_id, created_at desc);

do $$
begin
  if to_regclass('public.tiktok_videos') is not null then
    alter table public.tiktok_videos add column if not exists primary_url text;
    alter table public.tiktok_videos add column if not exists backup_url text;
    alter table public.tiktok_videos add column if not exists storage_provider text default 'supabase';
    alter table public.tiktok_videos add column if not exists replication_status text default 'pending';
    alter table public.tiktok_videos add column if not exists last_sync_at timestamptz;
  end if;

  if to_regclass('public.media') is not null then
    alter table public.media add column if not exists primary_url text;
    alter table public.media add column if not exists backup_url text;
    alter table public.media add column if not exists storage_provider text default 'supabase';
    alter table public.media add column if not exists replication_status text default 'pending';
    alter table public.media add column if not exists last_sync_at timestamptz;
  end if;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_promotional_campaigns_updated_at on public.promotional_campaigns;
create trigger trg_promotional_campaigns_updated_at
before update on public.promotional_campaigns
for each row execute function public.set_updated_at();

drop trigger if exists trg_media_storage_replicas_updated_at on public.media_storage_replicas;
create trigger trg_media_storage_replicas_updated_at
before update on public.media_storage_replicas
for each row execute function public.set_updated_at();

create or replace function public.record_promotional_campaign_event(
  p_campaign_id uuid,
  p_event_type text,
  p_viewer_hash text default null,
  p_user_id text default null,
  p_session_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_impressions bigint;
  v_clicks bigint;
  v_unique_viewers bigint;
begin
  if p_event_type not in ('impression', 'click', 'close') then
    raise exception 'Unsupported promotional campaign event type: %', p_event_type;
  end if;

  insert into public.promotional_campaign_events (
    campaign_id,
    event_type,
    viewer_hash,
    user_id,
    session_id,
    ip_hash,
    user_agent,
    metadata
  )
  values (
    p_campaign_id,
    p_event_type,
    nullif(p_viewer_hash, ''),
    nullif(p_user_id, ''),
    nullif(p_session_id, ''),
    nullif(p_ip_hash, ''),
    nullif(p_user_agent, ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_event_id;

  if p_event_type = 'impression' then
    update public.promotional_campaigns
      set impressions = coalesce(impressions, 0) + 1
      where id = p_campaign_id;
  elsif p_event_type = 'click' then
    update public.promotional_campaigns
      set clicks = coalesce(clicks, 0) + 1
      where id = p_campaign_id;
  end if;

  select
    coalesce(max(c.impressions), 0),
    coalesce(max(c.clicks), 0),
    coalesce(count(distinct e.viewer_hash) filter (
      where e.event_type = 'impression' and e.viewer_hash is not null
    ), 0)
  into v_impressions, v_clicks, v_unique_viewers
  from public.promotional_campaigns c
  left join public.promotional_campaign_events e on e.campaign_id = c.id
  where c.id = p_campaign_id;

  update public.promotional_campaigns
    set unique_viewers = v_unique_viewers
    where id = p_campaign_id;

  return jsonb_build_object(
    'eventId', v_event_id,
    'impressions', v_impressions,
    'clicks', v_clicks,
    'uniqueViewers', v_unique_viewers,
    'ctr', case when v_impressions > 0 then (v_clicks::numeric / v_impressions::numeric) else 0 end
  );
end;
$$;
