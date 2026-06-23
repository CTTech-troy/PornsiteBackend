-- Store creator upload legal/compliance acknowledgements with published video rows.

alter table if exists public.tiktok_videos
  add column if not exists content_compliance_acknowledged boolean not null default false,
  add column if not exists content_compliance_acknowledged_at timestamptz,
  add column if not exists content_compliance_version text,
  add column if not exists content_compliance_acknowledgements jsonb not null default '{}'::jsonb,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_tiktok_videos_content_compliance_ack
  on public.tiktok_videos (content_compliance_acknowledged, content_compliance_acknowledged_at desc);
