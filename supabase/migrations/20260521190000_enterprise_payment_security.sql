-- Enterprise payment security: intents, webhook replay, audit/fraud logs, atomic coin fulfillment.
-- Run BEFORE 20260522120000_secure_payment_hardening.sql

create table if not exists public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  intent_key text not null unique,
  user_id text not null,
  product_type text not null,
  product_id text not null,
  amount numeric(12, 2) not null,
  official_amount numeric(12, 2) not null,
  currency text not null default 'USD',
  official_units integer not null default 0,
  status text not null default 'created',
  provider text,
  provider_reference text,
  checkout_url text,
  idempotency_key text unique,
  expires_at timestamptz not null,
  fulfilled_at timestamptz,
  request_ip_hash text,
  user_agent_hash text,
  risk_score integer not null default 0,
  risk_flags jsonb not null default '[]'::jsonb,
  product_snapshot jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_intents_user_created_idx
  on public.payment_intents(user_id, created_at desc);

create index if not exists payment_intents_provider_reference_idx
  on public.payment_intents(provider, provider_reference)
  where provider_reference is not null;

create index if not exists payment_intents_status_expires_idx
  on public.payment_intents(status, expires_at);

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references public.payment_intents(id) on delete cascade,
  provider text not null,
  provider_reference text not null,
  provider_transaction_id text,
  event_type text not null default 'payment.verified',
  status text not null default 'verified',
  amount numeric(12, 2),
  currency text,
  verified boolean not null default false,
  raw_event jsonb not null default '{}'::jsonb,
  raw_verification jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(provider, provider_reference)
);

create index if not exists payment_transactions_intent_idx
  on public.payment_transactions(intent_id, created_at asc);

create table if not exists public.payment_audit_logs (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid references public.payment_intents(id) on delete set null,
  user_id text,
  event_type text not null,
  actor_type text not null default 'system',
  actor_id text,
  ip_hash text,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payment_audit_logs_intent_idx
  on public.payment_audit_logs(intent_id, created_at asc);

create table if not exists public.fraud_detection_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  intent_id uuid references public.payment_intents(id) on delete set null,
  provider text,
  provider_reference text,
  risk_score integer not null default 0,
  risk_flags jsonb not null default '[]'::jsonb,
  reason text not null,
  status text not null default 'open',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists fraud_detection_logs_status_created_idx
  on public.fraud_detection_logs(status, created_at desc);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text,
  provider_reference text,
  event_type text not null default 'unknown',
  signature_valid boolean not null default false,
  replay_key text not null,
  status text not null default 'received',
  error_message text,
  headers jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(replay_key)
);

create index if not exists webhook_events_provider_received_idx
  on public.webhook_events(provider, received_at desc);

create table if not exists public.token_credits (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  intent_id uuid references public.payment_intents(id) on delete set null,
  package_id text,
  coins integer not null,
  provider text,
  provider_reference text not null unique,
  wallet_transaction_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.membership_billing_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  membership_id uuid,
  provider text,
  provider_reference text,
  amount numeric(12, 2),
  currency text,
  status text not null,
  billing_reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(provider_reference, billing_reason)
);

create or replace function public.secure_fulfill_coin_payment(
  p_intent_id uuid,
  p_provider text,
  p_provider_reference text,
  p_amount numeric,
  p_currency text,
  p_verification jsonb default '{}'::jsonb,
  p_event jsonb default '{}'::jsonb
)
returns table(new_balance numeric, token_credit_id uuid, wallet_transaction_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intent payment_intents%rowtype;
  v_existing_credit uuid;
  v_wallet_tx uuid;
  v_new_balance numeric;
  v_expected_currency text;
  v_tolerance numeric;
  v_now timestamptz := now();
  v_coins integer;
begin
  if p_intent_id is null or p_provider_reference is null then
    raise exception 'payment_intent_and_reference_required';
  end if;

  select * into v_intent
    from public.payment_intents
   where id = p_intent_id
   for update;

  if not found then
    raise exception 'payment_intent_not_found';
  end if;

  select id into v_existing_credit
    from public.token_credits
   where provider_reference = p_provider_reference
   limit 1;

  if found or v_intent.status = 'fulfilled' then
    new_balance := null;
    token_credit_id := v_existing_credit;
    wallet_transaction_id := null;
    duplicate := true;
    return next;
    return;
  end if;

  if v_intent.status in ('failed', 'expired', 'cancelled', 'suspicious') then
    raise exception 'payment_intent_not_processable';
  end if;

  if v_intent.expires_at < v_now then
    update public.payment_intents
       set status = 'expired', updated_at = v_now
     where id = v_intent.id;
    raise exception 'payment_intent_expired';
  end if;

  if v_intent.product_type not in ('coins', 'coin', 'tokens', 'token') then
    raise exception 'payment_intent_not_coin_product';
  end if;

  v_expected_currency := upper(v_intent.currency);
  v_tolerance := case when v_expected_currency = 'NGN' then 1 else 0.01 end;

  if upper(coalesce(p_currency, '')) <> v_expected_currency
     or abs(coalesce(p_amount, -1) - v_intent.official_amount) > v_tolerance then
    update public.payment_intents
       set status = 'suspicious',
           risk_score = greatest(risk_score, 95),
           risk_flags = risk_flags || jsonb_build_array('amount_or_currency_mismatch'),
           updated_at = v_now
     where id = v_intent.id;
    insert into public.fraud_detection_logs (
      user_id, intent_id, provider, provider_reference, risk_score, risk_flags, reason, metadata
    )
    values (
      v_intent.user_id, v_intent.id, p_provider, p_provider_reference, 95,
      '["amount_or_currency_mismatch"]'::jsonb,
      'Provider amount/currency did not match official coin package price',
      jsonb_build_object('expectedAmount', v_intent.official_amount, 'paidAmount', p_amount)
    );
    raise exception 'payment_amount_or_currency_mismatch';
  end if;

  v_coins := greatest(coalesce(v_intent.official_units, 0), 0);
  if v_coins <= 0 then
    raise exception 'payment_intent_invalid_coin_units';
  end if;

  insert into public.payment_transactions (
    intent_id, provider, provider_reference, provider_transaction_id,
    event_type, status, amount, currency, verified, raw_event, raw_verification
  )
  values (
    v_intent.id, p_provider, p_provider_reference,
    coalesce(p_verification->>'providerTransactionId', p_verification->>'id'),
    coalesce(p_event->>'eventType', 'payment.verified'),
    'verified', p_amount, v_expected_currency, true,
    coalesce(p_event, '{}'::jsonb), coalesce(p_verification, '{}'::jsonb)
  )
  on conflict (provider, provider_reference) do nothing;

  insert into public.users (id) values (v_intent.user_id) on conflict (id) do nothing;

  select new_balance, transaction_id
    into v_new_balance, v_wallet_tx
    from public.credit_coin_wallet(
      v_intent.user_id,
      v_coins::numeric,
      'purchase',
      p_provider_reference,
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'packageId', v_intent.product_id,
        'provider', p_provider
      ),
      'coin_purchase:' || p_provider_reference,
      p_provider,
      'coin_package',
      v_intent.product_id
    )
    limit 1;

  insert into public.token_credits (
    user_id, intent_id, package_id, coins, provider, provider_reference, wallet_transaction_id
  )
  values (
    v_intent.user_id, v_intent.id, v_intent.product_id, v_coins,
    p_provider, p_provider_reference, v_wallet_tx
  )
  returning id into token_credit_id;

  update public.payment_intents
     set status = 'fulfilled',
         provider = p_provider,
         provider_reference = p_provider_reference,
         fulfilled_at = v_now,
         updated_at = v_now
   where id = v_intent.id;

  insert into public.payment_audit_logs (intent_id, user_id, event_type, message, metadata)
  values (
    v_intent.id, v_intent.user_id, 'payment.coins_credited',
    'Verified provider payment credited coins atomically',
    jsonb_build_object('tokenCreditId', token_credit_id, 'coins', v_coins, 'packageId', v_intent.product_id)
  );

  new_balance := v_new_balance;
  wallet_transaction_id := v_wallet_tx;
  duplicate := false;
  return next;
end;
$$;

revoke all on function public.secure_fulfill_coin_payment(uuid, text, text, numeric, text, jsonb, jsonb) from public;
grant execute on function public.secure_fulfill_coin_payment(uuid, text, text, numeric, text, jsonb, jsonb) to service_role;

grant all on public.payment_intents to service_role;
grant all on public.payment_transactions to service_role;
grant all on public.payment_audit_logs to service_role;
grant all on public.fraud_detection_logs to service_role;
grant all on public.webhook_events to service_role;
grant all on public.token_credits to service_role;
grant all on public.membership_billing_logs to service_role;

alter table public.payment_intents enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.payment_audit_logs enable row level security;
alter table public.fraud_detection_logs enable row level security;
alter table public.webhook_events enable row level security;
alter table public.token_credits enable row level security;
alter table public.membership_billing_logs enable row level security;
