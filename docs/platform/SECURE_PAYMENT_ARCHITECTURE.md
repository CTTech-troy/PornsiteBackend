# Secure Payment Architecture

This platform uses server-created payment intents and provider webhooks as the only fulfillment path. The frontend never sends an amount, token quantity, or success status.

## Runtime Flow

1. The user selects a membership plan or coin package.
2. The frontend sends only `planId` or `packageId`.
3. The Node backend loads the official product from Supabase, creates a `payment_intents` row, and signs the checkout request to the C# payment service.
4. The payment service creates a provider checkout session with explicit metadata: `productType`, `productId`, `orderId`, `userId`, and idempotency data.
5. Provider webhooks hit `/api/payments/webhooks/:provider`.
6. The backend verifies the webhook signature, independently re-queries the provider verification endpoint, validates amount, currency, user, product, reference, and status, then fulfills once.
7. Coin/token crediting happens inside `secure_fulfill_coin_payment()` with row locks and idempotency.

## Important Files

- `backend/src/services/securePayments.service.js` - payment intent orchestration, fraud signals, webhook processing, admin monitoring.
- `backend/src/services/paymentGateway.service.js` - Paystack, Flutterwave, and Stripe signature and verification adapters.
- `backend/src/services/paymentRegion.service.js` - Africa → Flutterwave, international → Paystack routing.
- `backend/src/services/paymentServiceClient.js` - signed internal checkout requests to the C# payment service.
- `payment-service/Gateways/*Gateway.cs` - provider checkout adapters.
- `backend/supabase/migrations/20260521190000_enterprise_payment_security.sql` - payment intents, immutable logs, webhook replay tracking, and atomic coin fulfillment RPC.
- `backend/src/router/payment.route.js` - compatibility payment routes and secure provider webhooks.
- `backend/src/router/monetizationWorkflow.route.js` - signed QStash payment maintenance workflows.

## Required Secrets

Set these on Render and never expose them to frontend builds:

```env
PAYMENT_SERVICE_URL=
PAYMENT_SERVICE_SHARED_SECRET=
PAYMENT_DEFAULT_PROVIDER=paystack
PAYMENT_AFRICA_PROVIDER=flutterwave

PAYSTACK_SECRET_KEY=
FLUTTERWAVE_PUBLIC_KEY=
FLUTTERWAVE_SECRET_KEY=
FLUTTERWAVE_ENCRYPTION_KEY=
FLUTTERWAVE_WEBHOOK_HASH=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

Use the same `PAYMENT_SERVICE_SHARED_SECRET` in both the Node backend and C# payment service. Rotate provider webhook secrets by configuring the new provider secret first, updating the provider dashboard, then deploying.

## Testing

Run the payment migration first:

```bash
cd backend
npm run start
```

Then test checkout creation:

```bash
curl -X POST "$API_URL/api/coins/purchase" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"packageId":"tokens_100","countryCode":"US"}'
```

Verify a returned reference without fulfilling from the client:

```bash
curl "$API_URL/api/payments/verify/$REFERENCE" \
  -H "Authorization: Bearer $USER_TOKEN"
```

Webhook tests should include:

- Missing signature returns `401`.
- Invalid signature returns `401`.
- Duplicate webhook returns `duplicate: true` and does not credit again.
- Amount mismatch marks the intent `suspicious` and writes `fraud_detection_logs`.
- Concurrent duplicate webhooks create only one `token_credits` row.

## Wallet and gift security

- `GET /api/coins/gifts` returns server-side `gift_catalog` pricing
- `POST /api/tokens/send-gift` and `POST /api/coins/gift` accept `giftId` only (client `price` ignored)
- Spend/transfer/gift routes use `COIN_WALLET_MAX_PER_MIN` rate limiting

## Membership fulfillment

- `secure_fulfill_membership_payment` RPC activates membership atomically with idempotency on `payment_reference`

## QStash Workflows

Create schedules from the backend service:

```bash
cd backend
npm run qstash:create-monetization
```

This includes membership expiry/reminders plus payment intent expiration, reconciliation, and fraud analysis jobs under `/api/internal/qstash/monetization`.

## Production Notes

- Keep `SUPABASE_SERVICE_ROLE_KEY`, provider secrets, QStash signing keys, and `PAYMENT_SERVICE_SHARED_SECRET` server-side only.
- Configure provider dashboard webhook URLs:
  - `/api/payments/webhooks/paystack`
  - `/api/payments/webhooks/stripe`
  - `/api/payments/webhooks/flutterwave`
- Do not credit balances from frontend callbacks. The callback page only reads intent status.
- Use Supabase migrations before enabling paid traffic.
- Monitor `/api/admin/finance/payments` for suspicious intents, failed webhooks, and reconciliation drift.
