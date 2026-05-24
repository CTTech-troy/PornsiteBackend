-- Flutterwave production payment readiness:
-- unified finance activity feed, Flutterwave payout metadata, and atomic
-- premium-video coin purchase fulfillment.

alter table public.creator_payout_requests
  add column if not exists flutterwave_transfer_id text,
  add column if not exists flutterwave_transaction_reference text,
  add column if not exists flutterwave_status text,
  add column if not exists flutterwave_recipient jsonb not null default '{}'::jsonb;

create index if not exists creator_payout_requests_flutterwave_transfer_idx
  on public.creator_payout_requests(flutterwave_transfer_id)
  where flutterwave_transfer_id is not null;

create index if not exists creator_payout_requests_flutterwave_reference_idx
  on public.creator_payout_requests(flutterwave_transaction_reference)
  where flutterwave_transaction_reference is not null;

create unique index if not exists payout_transactions_provider_reference_unique
  on public.payout_transactions(provider, provider_reference)
  where provider_reference is not null;

create index if not exists payment_intents_intent_key_lookup_idx
  on public.payment_intents(intent_key);

create unique index if not exists premium_video_purchases_user_video_active_unique
  on public.premium_video_purchases(user_id, video_id)
  where access_status = 'active' and refund_status = 'none';

create table if not exists public.finance_activity_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  actor_type text not null default 'system',
  actor_id text,
  user_id text,
  creator_id text,
  product_type text,
  product_id text,
  amount_usd numeric(14,2),
  amount_tokens numeric(18,2),
  provider text,
  reference text,
  status text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists finance_activity_events_created_idx
  on public.finance_activity_events(created_at desc);

create index if not exists finance_activity_events_type_created_idx
  on public.finance_activity_events(event_type, created_at desc);

create index if not exists finance_activity_events_user_created_idx
  on public.finance_activity_events(user_id, created_at desc)
  where user_id is not null;

create index if not exists finance_activity_events_creator_created_idx
  on public.finance_activity_events(creator_id, created_at desc)
  where creator_id is not null;

alter table public.creator_earnings
  drop constraint if exists creator_earnings_source_check;

alter table public.creator_earnings
  add constraint creator_earnings_source_check
  check (source in (
    'live_gifts', 'video_views', 'purchase', 'premium_video', 'video_purchase',
    'ad', 'ad_impression', 'ad_reward', 'subscription', 'membership', 'live_gift'
  ));

create or replace function public.secure_purchase_premium_video(
  p_user_id text,
  p_creator_id text,
  p_video_id text,
  p_tiktok_video_id text,
  p_video_title text,
  p_token_price numeric,
  p_purchase_amount_usd numeric,
  p_creator_revenue_usd numeric,
  p_platform_revenue_usd numeric,
  p_payment_reference text,
  p_device_info jsonb default '{}'::jsonb,
  p_session_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table(purchase_id uuid, new_balance numeric, wallet_transaction_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_purchase_id uuid := gen_random_uuid();
  v_wallet_tx uuid;
  v_new_balance numeric;
  v_reference text;
  v_idempotency_key text;
begin
  if p_user_id is null or length(trim(p_user_id)) = 0 then
    raise exception 'user_id_required';
  end if;
  if p_video_id is null or length(trim(p_video_id)) = 0 then
    raise exception 'video_id_required';
  end if;
  if coalesce(p_token_price, 0) < 0 then
    raise exception 'token_price_invalid';
  end if;

  select id into v_existing
    from public.premium_video_purchases
   where user_id = p_user_id
     and video_id = p_video_id
     and access_status = 'active'
     and refund_status = 'none'
   limit 1;

  if found then
    select balance into v_new_balance from public.coin_wallets where user_id = p_user_id;
    purchase_id := v_existing;
    new_balance := coalesce(v_new_balance, 0);
    wallet_transaction_id := null;
    duplicate := true;
    return next;
    return;
  end if;

  perform public.ensure_coin_wallet(p_user_id);
  perform 1 from public.coin_wallets where user_id = p_user_id for update;

  -- Recheck after taking the wallet lock so two concurrent purchases cannot
  -- both debit the same buyer before one creates the access row.
  select id into v_existing
    from public.premium_video_purchases
   where user_id = p_user_id
     and video_id = p_video_id
     and access_status = 'active'
     and refund_status = 'none'
   limit 1;

  if found then
    select balance into v_new_balance from public.coin_wallets where user_id = p_user_id;
    purchase_id := v_existing;
    new_balance := coalesce(v_new_balance, 0);
    wallet_transaction_id := null;
    duplicate := true;
    return next;
    return;
  end if;

  v_reference := coalesce(p_payment_reference, 'premium_video:' || p_user_id || ':' || p_video_id);
  v_idempotency_key := 'premium_video_purchase:' || p_user_id || ':' || p_video_id;

  if coalesce(p_token_price, 0) > 0 then
    select d.new_balance, d.transaction_id
      into v_new_balance, v_wallet_tx
      from public.debit_coin_wallet(
        p_user_id,
        p_token_price,
        'spend',
        v_reference,
        coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
          'reason', 'premium_video_purchase',
          'videoId', p_video_id,
          'creatorId', p_creator_id
        ),
        v_idempotency_key,
        p_creator_id,
        'premium_video',
        p_video_id
      ) as d
      limit 1;
  else
    select balance into v_new_balance from public.coin_wallets where user_id = p_user_id;
  end if;

  insert into public.premium_video_purchases (
    id,
    user_id,
    creator_id,
    video_id,
    tiktok_video_id,
    video_title,
    purchase_amount_tokens,
    purchase_amount_usd,
    creator_revenue_usd,
    platform_revenue_usd,
    currency,
    payment_reference,
    payment_provider,
    access_status,
    refund_status,
    device_info,
    session_id,
    idempotency_key,
    metadata
  )
  values (
    v_purchase_id,
    p_user_id,
    p_creator_id,
    p_video_id,
    p_tiktok_video_id,
    coalesce(p_video_title, ''),
    coalesce(p_token_price, 0),
    coalesce(p_purchase_amount_usd, 0),
    coalesce(p_creator_revenue_usd, 0),
    coalesce(p_platform_revenue_usd, 0),
    'USD',
    v_reference,
    'coin_wallet',
    'active',
    'none',
    coalesce(p_device_info, '{}'::jsonb),
    p_session_id,
    v_idempotency_key,
    coalesce(p_metadata, '{}'::jsonb)
      || jsonb_build_object('walletTransactionId', v_wallet_tx)
  );

  if p_creator_id is not null and coalesce(p_creator_revenue_usd, 0) > 0 then
    insert into public.creator_earnings (
      creator_id,
      amount_usd,
      gross_usd,
      platform_fee_usd,
      source,
      reference_id,
      metadata,
      created_at
    )
    values (
      p_creator_id,
      round(coalesce(p_creator_revenue_usd, 0), 2),
      round(coalesce(p_purchase_amount_usd, 0), 2),
      round(coalesce(p_platform_revenue_usd, 0), 2),
      'video_purchase',
      'premium_purchase:' || v_purchase_id::text,
      jsonb_build_object(
        'videoId', p_video_id,
        'purchaseId', v_purchase_id,
        'buyerId', p_user_id,
        'tokenPrice', p_token_price
      ),
      now()
    )
    on conflict (reference_id) where reference_id is not null do nothing;
  end if;

  insert into public.premium_purchase_audit_log (
    purchase_id,
    event_type,
    user_id,
    creator_id,
    video_id,
    payload
  )
  values (
    v_purchase_id,
    'purchase_completed_atomic',
    p_user_id,
    p_creator_id,
    p_video_id,
    jsonb_build_object(
      'tokenPrice', p_token_price,
      'walletTransactionId', v_wallet_tx,
      'purchaseAmountUsd', p_purchase_amount_usd,
      'creatorRevenueUsd', p_creator_revenue_usd,
      'platformRevenueUsd', p_platform_revenue_usd
    )
  );

  insert into public.finance_activity_events (
    event_type,
    user_id,
    creator_id,
    product_type,
    product_id,
    amount_usd,
    amount_tokens,
    provider,
    reference,
    status,
    metadata
  )
  values (
    'premium_video_purchased',
    p_user_id,
    p_creator_id,
    'premium_video',
    p_video_id,
    round(coalesce(p_purchase_amount_usd, 0), 2),
    coalesce(p_token_price, 0),
    'coin_wallet',
    v_reference,
    'completed',
    jsonb_build_object(
      'purchaseId', v_purchase_id,
      'walletTransactionId', v_wallet_tx,
      'creatorRevenueUsd', p_creator_revenue_usd,
      'platformRevenueUsd', p_platform_revenue_usd,
      'videoTitle', p_video_title
    )
  );

  purchase_id := v_purchase_id;
  new_balance := coalesce(v_new_balance, 0);
  wallet_transaction_id := v_wallet_tx;
  duplicate := false;
  return next;
end;
$$;

revoke all on function public.secure_purchase_premium_video(
  text, text, text, text, text, numeric, numeric, numeric, numeric, text, jsonb, text, jsonb
) from public;
grant execute on function public.secure_purchase_premium_video(
  text, text, text, text, text, numeric, numeric, numeric, numeric, text, jsonb, text, jsonb
) to service_role;

grant all on public.finance_activity_events to service_role;
alter table public.finance_activity_events enable row level security;
