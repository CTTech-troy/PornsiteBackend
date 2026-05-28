-- Optimized lookups for the unified admin Payment History view.
-- The checks keep this migration safe on deployments where optional finance
-- tables have not been created yet.

do $$
begin
  if to_regclass('public.payment_intents') is not null then
    create index if not exists payment_intents_history_filter_idx
      on public.payment_intents(product_type, status, provider, created_at desc);
    create index if not exists payment_intents_history_reference_idx
      on public.payment_intents(provider_reference)
      where provider_reference is not null;
  end if;

  if to_regclass('public.token_credits') is not null then
    create index if not exists token_credits_history_user_created_idx
      on public.token_credits(user_id, created_at desc);
  end if;

  if to_regclass('public.coin_wallet_transactions') is not null then
    create index if not exists coin_wallet_transactions_history_filter_idx
      on public.coin_wallet_transactions(type, status, provider, created_at desc);
  end if;

  if to_regclass('public.user_memberships') is not null then
    create index if not exists user_memberships_history_filter_idx
      on public.user_memberships(status, payment_provider, started_at desc);
    create index if not exists user_memberships_history_reference_idx
      on public.user_memberships(payment_reference)
      where payment_reference is not null;
  end if;

  if to_regclass('public.membership_billing_logs') is not null then
    create index if not exists membership_billing_logs_history_filter_idx
      on public.membership_billing_logs(status, provider, created_at desc);
  end if;

  if to_regclass('public.premium_video_purchases') is not null then
    create index if not exists premium_video_purchases_history_filter_idx
      on public.premium_video_purchases(payment_provider, access_status, refund_status, purchased_at desc);
    create index if not exists premium_video_purchases_history_reference_idx
      on public.premium_video_purchases(payment_reference)
      where payment_reference is not null;
  end if;

  if to_regclass('public.creator_payout_requests') is not null then
    create index if not exists creator_payout_requests_history_filter_idx
      on public.creator_payout_requests(status, payment_provider, requested_at desc);
    create index if not exists creator_payout_requests_history_transaction_idx
      on public.creator_payout_requests(transaction_reference)
      where transaction_reference is not null;
  end if;

  if to_regclass('public.finance_activity_events') is not null then
    create index if not exists finance_activity_events_history_feed_idx
      on public.finance_activity_events(event_type, created_at desc);
  end if;
end $$;
