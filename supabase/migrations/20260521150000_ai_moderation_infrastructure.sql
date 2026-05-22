create extension if not exists pgcrypto;

create table if not exists public.ai_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  session_type text not null default 'livestream',
  status text not null default 'active',
  title text,
  creator_id text,
  hidden_participant_id text not null default 'system_ai',
  hidden_participant_metadata jsonb not null default '{"hidden": true, "role": "system_ai"}'::jsonb,
  risk_score numeric(6,2) not null default 0,
  max_risk_score numeric(6,2) not null default 0,
  event_count integer not null default 0,
  alert_count integer not null default 0,
  last_event_at timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_sessions_status_check check (status in ('active', 'paused', 'ended', 'failed')),
  constraint ai_sessions_type_check check (session_type in ('livestream', 'ivi', 'upload', 'chat', 'behavior', 'finance', 'system'))
);

create table if not exists public.moderation_events (
  id uuid primary key default gen_random_uuid(),
  ai_session_id uuid references public.ai_sessions(id) on delete set null,
  session_id text,
  session_type text,
  event_type text not null,
  source text not null default 'system',
  user_id text,
  peer_user_id text,
  content_type text,
  content_id text,
  content_ref text,
  message text,
  transcript text,
  risk_score numeric(6,2) not null default 0,
  confidence numeric(6,2) not null default 0,
  severity text not null default 'info',
  verdict text not null default 'allow',
  model_name text,
  labels jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint moderation_events_severity_check check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  constraint moderation_events_verdict_check check (verdict in ('allow', 'review', 'block', 'escalate'))
);

create table if not exists public.ai_alerts (
  id uuid primary key default gen_random_uuid(),
  ai_session_id uuid references public.ai_sessions(id) on delete set null,
  moderation_event_id uuid references public.moderation_events(id) on delete set null,
  session_id text,
  alert_type text not null,
  severity text not null default 'medium',
  status text not null default 'open',
  title text not null,
  description text,
  risk_score numeric(6,2) not null default 0,
  assigned_to text,
  escalated_at timestamptz,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolution_note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_alerts_severity_check check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  constraint ai_alerts_status_check check (status in ('open', 'acknowledged', 'reviewing', 'resolved', 'dismissed'))
);

create table if not exists public.flagged_content (
  id uuid primary key default gen_random_uuid(),
  ai_session_id uuid references public.ai_sessions(id) on delete set null,
  moderation_event_id uuid references public.moderation_events(id) on delete set null,
  content_id text,
  content_type text not null,
  user_id text,
  snapshot_url text,
  storage_path text,
  reason text,
  labels jsonb not null default '{}'::jsonb,
  risk_score numeric(6,2) not null default 0,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  constraint flagged_content_status_check check (status in ('pending', 'reviewed', 'dismissed', 'actioned'))
);

create table if not exists public.moderation_reviews (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid references public.ai_alerts(id) on delete set null,
  moderation_event_id uuid references public.moderation_events(id) on delete set null,
  reviewer_id text,
  reviewer_name text,
  status text not null default 'reviewed',
  action text not null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_risk_scores (
  id uuid primary key default gen_random_uuid(),
  ai_session_id uuid references public.ai_sessions(id) on delete cascade,
  session_id text,
  category text not null default 'overall',
  model_name text,
  score numeric(6,2) not null default 0,
  confidence numeric(6,2) not null default 0,
  window_start timestamptz not null default now(),
  window_end timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.user_behavior_profiles (
  user_id text primary key,
  risk_score numeric(6,2) not null default 0,
  anomaly_score numeric(6,2) not null default 0,
  events_count integer not null default 0,
  strikes_count integer not null default 0,
  last_seen_at timestamptz,
  features jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.fraud_detection_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  entity_type text not null,
  entity_id text,
  risk_score numeric(6,2) not null default 0,
  reason text,
  signals jsonb not null default '{}'::jsonb,
  status text not null default 'open',
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint fraud_detection_logs_status_check check (status in ('open', 'reviewing', 'resolved', 'dismissed'))
);

create table if not exists public.ai_training_logs (
  id uuid primary key default gen_random_uuid(),
  initiated_by text,
  dataset_name text,
  model_name text not null,
  status text not null default 'queued',
  threshold_config jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  started_at timestamptz default now(),
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  constraint ai_training_logs_status_check check (status in ('queued', 'running', 'completed', 'failed', 'cancelled'))
);

create table if not exists public.ai_worker_health (
  worker_id text primary key,
  worker_type text not null default 'inference',
  status text not null default 'unknown',
  model_name text,
  gpu_name text,
  gpu_memory_used_mb integer,
  gpu_memory_total_mb integer,
  queue_depth integer not null default 0,
  inference_latency_ms numeric(10,2) not null default 0,
  throughput_per_minute numeric(10,2) not null default 0,
  last_heartbeat_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint ai_worker_health_status_check check (status in ('healthy', 'degraded', 'offline', 'unknown'))
);

create table if not exists public.ai_moderation_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null unique,
  label text not null,
  category text not null default 'policy',
  value jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.ai_flags (
  id uuid primary key default gen_random_uuid(),
  content_id text,
  content_type text,
  reason text,
  severity text,
  status text not null default 'pending',
  review_note text,
  reviewed_at timestamptz,
  reviewed_by text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into public.ai_moderation_rules (rule_key, label, category, value)
values
  ('risk_thresholds', 'Risk thresholds', 'thresholds', '{"review": 45, "alert": 65, "critical": 85}'::jsonb),
  ('frame_sampling', 'Frame sampling', 'performance', '{"livestream_seconds": 15, "ivi_seconds": 10, "max_frames_per_minute": 8}'::jsonb),
  ('banned_phrases', 'Banned phrases', 'text', '{"phrases": ["kill yourself", "send money off platform", "chargeback scam"]}'::jsonb),
  ('model_routing', 'Model routing', 'inference', '{"vision": "qwen2.5-vl", "audio": "whisper", "text": "detoxify", "objects": "yolov8", "nudity": "nudenet", "behavior": "isolation_forest"}'::jsonb)
on conflict (rule_key) do nothing;

create index if not exists ai_sessions_status_idx on public.ai_sessions(status, started_at desc);
create index if not exists ai_sessions_creator_idx on public.ai_sessions(creator_id, started_at desc);
create index if not exists moderation_events_session_idx on public.moderation_events(session_id, created_at desc);
create index if not exists moderation_events_severity_idx on public.moderation_events(severity, created_at desc);
create index if not exists ai_alerts_status_idx on public.ai_alerts(status, severity, created_at desc);
create index if not exists flagged_content_status_idx on public.flagged_content(status, created_at desc);
create index if not exists ai_risk_scores_session_idx on public.ai_risk_scores(session_id, created_at desc);
create index if not exists fraud_detection_logs_user_idx on public.fraud_detection_logs(user_id, created_at desc);
create index if not exists ai_flags_status_idx on public.ai_flags(status, created_at desc);

alter table public.ai_sessions enable row level security;
alter table public.moderation_events enable row level security;
alter table public.ai_alerts enable row level security;
alter table public.flagged_content enable row level security;
alter table public.moderation_reviews enable row level security;
alter table public.ai_risk_scores enable row level security;
alter table public.user_behavior_profiles enable row level security;
alter table public.fraud_detection_logs enable row level security;
alter table public.ai_training_logs enable row level security;
alter table public.ai_worker_health enable row level security;
alter table public.ai_moderation_rules enable row level security;

grant select, insert, update, delete on public.ai_sessions to service_role;
grant select, insert, update, delete on public.moderation_events to service_role;
grant select, insert, update, delete on public.ai_alerts to service_role;
grant select, insert, update, delete on public.flagged_content to service_role;
grant select, insert, update, delete on public.moderation_reviews to service_role;
grant select, insert, update, delete on public.ai_risk_scores to service_role;
grant select, insert, update, delete on public.user_behavior_profiles to service_role;
grant select, insert, update, delete on public.fraud_detection_logs to service_role;
grant select, insert, update, delete on public.ai_training_logs to service_role;
grant select, insert, update, delete on public.ai_worker_health to service_role;
grant select, insert, update, delete on public.ai_moderation_rules to service_role;
grant select, insert, update, delete on public.ai_flags to service_role;
