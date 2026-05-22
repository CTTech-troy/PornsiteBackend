-- Secure payment hardening: membership fulfillment RPC, indexes
-- Requires: 20260521190000_enterprise_payment_security.sql
-- Gift catalog: 20260523130000_gift_catalog_schema_migrate.sql

create unique index if not exists user_memberships_payment_reference_idx
  on public.user_memberships(payment_reference)
  where payment_reference is not null;

create or replace function public.secure_fulfill_membership_payment(
  p_intent_id uuid,
  p_provider text,
  p_provider_reference text,
  p_amount numeric,
  p_currency text,
  p_verification jsonb default '{}'::jsonb,
  p_event jsonb default '{}'::jsonb
)
returns table(membership_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intent payment_intents%rowtype;
  v_plan membership_plans%rowtype;
  v_membership_id uuid;
  v_existing_membership uuid;
  v_expected_currency text;
  v_tolerance numeric;
  v_now timestamptz := now();
  v_expires_at timestamptz;
  v_grace_ends_at timestamptz;
  v_duration_days integer;
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

  select id into v_existing_membership
    from public.user_memberships
   where payment_reference = p_provider_reference
   limit 1;

  if found or v_intent.status = 'fulfilled' then
    membership_id := v_existing_membership;
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

  if v_intent.product_type not in ('membership', 'subscription', 'plan') then
    raise exception 'payment_intent_not_membership_product';
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
      'Provider amount/currency did not match official membership price',
      jsonb_build_object('expectedAmount', v_intent.official_amount, 'paidAmount', p_amount)
    );
    raise exception 'payment_amount_or_currency_mismatch';
  end if;

  select * into v_plan
    from public.membership_plans
   where id = v_intent.product_id;

  if not found then
    raise exception 'membership_plan_not_found';
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

  v_duration_days := greatest(coalesce(v_plan.duration_days, 30), 1);
  v_expires_at := v_now + make_interval(days => v_duration_days);
  v_grace_ends_at := v_expires_at + interval '3 days';

  update public.user_memberships
     set status = 'cancelled',
         cancelled_at = v_now,
         updated_at = v_now
   where user_id = v_intent.user_id
     and status in ('active', 'grace', 'paused', 'past_due');

  insert into public.user_memberships (
    user_id, plan_id, coins_received, status, renewal_status,
    payment_reference, payment_provider, amount_paid_usd,
    started_at, expires_at, grace_ends_at, provider_metadata
  )
  values (
    v_intent.user_id,
    v_plan.id,
    coalesce(v_plan.coins, 0),
    'active',
    'none',
    p_provider_reference,
    p_provider,
    case when v_expected_currency = 'NGN' then round(p_amount / 1600.0, 2) else p_amount end,
    v_now,
    v_expires_at,
    v_grace_ends_at,
    coalesce(p_verification, '{}'::jsonb)
  )
  returning id into v_membership_id;

  update public.users
     set active_plan = v_plan.id,
         plan_expires_at = v_expires_at,
         plan_grace_ends_at = v_grace_ends_at
   where id = v_intent.user_id;

  if coalesce(v_plan.coins, 0) > 0 then
    perform public.credit_coin_wallet(
      v_intent.user_id,
      v_plan.coins,
      'bonus',
      p_provider_reference || ':membership_bonus',
      jsonb_build_object('planId', v_plan.id, 'membershipId', v_membership_id),
      'membership_bonus:' || v_intent.id::text,
      p_provider,
      'membership_plan',
      v_plan.id
    );
  end if;

  insert into public.membership_billing_logs (
    user_id, membership_id, provider, provider_reference,
    amount, currency, status, billing_reason, metadata
  )
  values (
    v_intent.user_id, v_membership_id, p_provider, p_provider_reference,
    p_amount, v_expected_currency, 'paid', 'initial_purchase',
    jsonb_build_object('paymentIntentId', v_intent.id, 'planId', v_plan.id)
  )
  on conflict do nothing;

  update public.payment_intents
     set status = 'fulfilled',
         provider = p_provider,
         provider_reference = p_provider_reference,
         fulfilled_at = v_now,
         updated_at = v_now
   where id = v_intent.id;

  insert into public.payment_audit_logs (intent_id, user_id, event_type, message, metadata)
  values (
    v_intent.id, v_intent.user_id, 'payment.membership_activated',
    'Verified provider payment activated membership atomically',
    jsonb_build_object('membershipId', v_membership_id, 'planId', v_plan.id)
  );

  membership_id := v_membership_id;
  duplicate := false;
  return next;
end;
$$;

revoke all on function public.secure_fulfill_membership_payment(uuid, text, text, numeric, text, jsonb, jsonb) from public;
grant execute on function public.secure_fulfill_membership_payment(uuid, text, text, numeric, text, jsonb, jsonb) to service_role;

-- gift_catalog grants/RLS: see 20260523130000_gift_catalog_schema_migrate.sql
