create extension if not exists pgcrypto;

create table if not exists public.email_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,
  version_label text not null,
  overrides jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid null,
  created_by_email text null,
  created_by_name text null,
  created_at timestamptz not null default now()
);

create index if not exists email_template_versions_template_key_idx
  on public.email_template_versions (template_key, created_at desc);

create unique index if not exists email_template_versions_one_active_idx
  on public.email_template_versions (template_key)
  where is_active = true;

create table if not exists public.email_template_send_log (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,
  recipient_email text not null,
  status text not null default 'sent',
  provider_message_id text null,
  error_message text null,
  sent_by uuid null,
  created_at timestamptz not null default now()
);

alter table public.email_template_versions enable row level security;
alter table public.email_template_send_log enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'email_template_versions'
      and policyname = 'service role manages email template versions'
  ) then
    create policy "service role manages email template versions"
      on public.email_template_versions
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'email_template_send_log'
      and policyname = 'service role manages email template send log'
  ) then
    create policy "service role manages email template send log"
      on public.email_template_send_log
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;
end $$;
