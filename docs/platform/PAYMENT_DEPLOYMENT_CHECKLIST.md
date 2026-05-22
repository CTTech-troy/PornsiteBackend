# Payment deployment checklist

## Database

1. Apply `supabase/migrations/20260521170000_monetization_architecture.sql` if coin wallets are not set up yet
2. Apply `supabase/migrations/20260521190000_enterprise_payment_security.sql` (creates `payment_intents` and related tables)
3. Apply `supabase/migrations/20260523130000_gift_catalog_schema_migrate.sql`
4. Apply `supabase/migrations/20260522120000_secure_payment_hardening.sql` (membership RPC; requires step 2)

## Environment (backend + payment-service)

- `PAYMENT_SERVICE_URL` / `PAYMENT_SERVICE_SHARED_SECRET` (same value on both services)
- `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH`, `FLUTTERWAVE_PUBLIC_KEY` (frontend)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `QSTASH_TOKEN`, signing keys for workflow endpoints
- Optional: `COIN_WALLET_MAX_PER_MIN=30`, `MAX_COIN_TRANSFER=100000`, `PAYMENT_RAPID_PURCHASE_LIMIT=8`

## Provider webhooks

Point each provider to:

- `https://{backend-host}/api/payments/webhooks/paystack`
- `https://{backend-host}/api/payments/webhooks/flutterwave`
- `https://{backend-host}/api/payments/webhooks/stripe` (optional)

## QStash schedules

```bash
cd backend
npm run qstash:create-monetization
```

## Verification

```bash
cd backend
node --test tests/payments/security.test.mjs
```

Manual checks:

- Coin purchase sends only `packageId`; webhook credits once; duplicate webhook does not double-credit
- Live gift sends only `giftId`; server debits catalog `coin_cost`
- Admin Payments tabs: fraud alerts, webhooks, reconciliation, audit trail
