-- Revenue dashboard: earnings columns, settings audit, commission rules

alter table if exists public.creator_earnings
  add column if not exists gross_usd numeric(12, 2),
  add column if not exists platform_fee_usd numeric(12, 2),
  add column if not exists reference_id text,
  add column if not exists metadata jsonb default '{}'::jsonb;

create unique index if not exists creator_earnings_reference_id_unique
  on public.creator_earnings (reference_id)
  where reference_id is not null;

create table if not exists public.platform_settings_audit (
  id uuid primary key default gen_random_uuid(),
  setting_key text not null,
  old_value text,
  new_value text,
  changed_by text not null default 'Admin',
  admin_id text,
  created_at timestamptz not null default now()
);

create index if not exists platform_settings_audit_key_created
  on public.platform_settings_audit (setting_key, created_at desc);

alter table public.platform_settings_audit enable row level security;

comment on table public.platform_settings_audit is 'Audit trail for admin platform setting changes, especially revenue settings.';
