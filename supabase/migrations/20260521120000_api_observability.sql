create extension if not exists pgcrypto;

create table if not exists public.api_request_logs (
  id uuid primary key default gen_random_uuid(),
  request_id text not null,
  api_name text not null,
  route_key text not null,
  route_group text,
  method text not null,
  endpoint text not null,
  status_code integer not null,
  success boolean not null default false,
  latency_ms integer not null default 0,
  request_bytes bigint not null default 0,
  response_bytes bigint not null default 0,
  operation_type text not null default 'other',
  ip_hash text,
  user_agent text,
  admin_id text,
  user_id text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists api_request_logs_created_at_idx
  on public.api_request_logs (created_at desc);

create index if not exists api_request_logs_route_created_idx
  on public.api_request_logs (route_key, created_at desc);

create index if not exists api_request_logs_status_idx
  on public.api_request_logs (status_code);

create index if not exists api_request_logs_success_idx
  on public.api_request_logs (success);

create index if not exists api_request_logs_operation_idx
  on public.api_request_logs (operation_type);

create table if not exists public.api_metric_rollups (
  bucket_start timestamptz not null,
  bucket_minutes integer not null default 1,
  route_key text not null,
  api_name text not null,
  route_group text,
  method text not null,
  endpoint text not null,
  total_requests integer not null default 0,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  read_count integer not null default 0,
  write_count integer not null default 0,
  latency_sum_ms bigint not null default 0,
  latency_min_ms integer,
  latency_max_ms integer not null default 0,
  latency_p50_ms integer not null default 0,
  latency_p95_ms integer not null default 0,
  latency_p99_ms integer not null default 0,
  request_bytes bigint not null default 0,
  response_bytes bigint not null default 0,
  uptime_checks integer not null default 0,
  uptime_ok integer not null default 0,
  health_score numeric(6,2) not null default 0,
  status text not null default 'healthy',
  last_status_code integer not null default 0,
  last_checked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (bucket_start, bucket_minutes, route_key, method)
);

create index if not exists api_metric_rollups_route_bucket_idx
  on public.api_metric_rollups (route_key, bucket_start desc);

create index if not exists api_metric_rollups_status_idx
  on public.api_metric_rollups (status);

create table if not exists public.api_incidents (
  id uuid primary key default gen_random_uuid(),
  route_key text not null,
  api_name text not null,
  status text not null,
  severity text not null default 'warning',
  reason text not null,
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  last_seen_at timestamptz not null default now(),
  sample jsonb not null default '{}'::jsonb,
  alert_dispatched_at timestamptz
);

create index if not exists api_incidents_route_idx
  on public.api_incidents (route_key, started_at desc);

create index if not exists api_incidents_open_idx
  on public.api_incidents (resolved_at)
  where resolved_at is null;

create table if not exists public.api_analytics_summaries (
  summary_date date not null,
  period text not null,
  route_key text not null,
  api_name text not null,
  total_requests integer not null default 0,
  failure_count integer not null default 0,
  avg_latency_ms integer not null default 0,
  p95_latency_ms integer not null default 0,
  uptime_pct numeric(6,2) not null default 0,
  peak_hour integer not null default 0,
  health_score numeric(6,2) not null default 0,
  created_at timestamptz not null default now(),
  primary key (summary_date, period, route_key)
);

alter table public.api_request_logs enable row level security;
alter table public.api_metric_rollups enable row level security;
alter table public.api_incidents enable row level security;
alter table public.api_analytics_summaries enable row level security;

grant select, insert, update, delete on public.api_request_logs to service_role;
grant select, insert, update, delete on public.api_metric_rollups to service_role;
grant select, insert, update, delete on public.api_incidents to service_role;
grant select, insert, update, delete on public.api_analytics_summaries to service_role;
