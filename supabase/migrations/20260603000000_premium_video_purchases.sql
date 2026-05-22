-- Premium video purchases, watch progress, and audit trail

create table if not exists public.premium_video_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  creator_id text,
  video_id text not null,
  tiktok_video_id text,
  video_title text,
  purchase_amount_tokens numeric(12, 2) not null default 0,
  purchase_amount_usd numeric(12, 2) not null default 0,
  creator_revenue_usd numeric(12, 2) not null default 0,
  platform_revenue_usd numeric(12, 2) not null default 0,
  currency text not null default 'USD',
  payment_reference text,
  payment_provider text default 'coin_wallet',
  access_status text not null default 'active',
  refund_status text not null default 'none',
  device_info jsonb default '{}'::jsonb,
  session_id text,
  idempotency_key text,
  metadata jsonb default '{}'::jsonb,
  purchased_at timestamptz not null default now(),
  refunded_at timestamptz,
  constraint premium_video_purchases_access_status_check
    check (access_status in ('active', 'revoked', 'expired')),
  constraint premium_video_purchases_refund_status_check
    check (refund_status in ('none', 'pending', 'completed', 'failed'))
);

create unique index if not exists premium_video_purchases_user_video_unique
  on public.premium_video_purchases (user_id, video_id);

create unique index if not exists premium_video_purchases_idempotency_unique
  on public.premium_video_purchases (idempotency_key)
  where idempotency_key is not null;

create index if not exists premium_video_purchases_creator_purchased
  on public.premium_video_purchases (creator_id, purchased_at desc);

create index if not exists premium_video_purchases_user_purchased
  on public.premium_video_purchases (user_id, purchased_at desc);

create table if not exists public.premium_video_watch_progress (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  video_id text not null,
  progress_seconds numeric(12, 2) not null default 0,
  duration_seconds numeric(12, 2),
  updated_at timestamptz not null default now(),
  unique (user_id, video_id)
);

create table if not exists public.premium_purchase_audit_log (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid references public.premium_video_purchases(id) on delete set null,
  event_type text not null,
  user_id text,
  creator_id text,
  video_id text,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists premium_purchase_audit_created
  on public.premium_purchase_audit_log (created_at desc);

alter table public.premium_video_purchases enable row level security;
alter table public.premium_video_watch_progress enable row level security;
alter table public.premium_purchase_audit_log enable row level security;
