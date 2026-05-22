# Payment migration: Monnify → Flutterwave + Paystack

## Summary

| Region | Provider | Checkout UX |
|--------|----------|-------------|
| African countries (ISO list in `paymentRegion.service.js`) | **Flutterwave** | Inline modal (`flutterwave-react-v3`) or hosted link fallback |
| Rest of world | **Paystack** | Redirect to Paystack hosted checkout |

Monnify has been **removed** from the payment-service and backend webhook routes.

## Environment variables

### Backend (`backend/.env`)

```env
PAYMENT_DEFAULT_PROVIDER=paystack
PAYMENT_AFRICA_PROVIDER=flutterwave

PAYSTACK_SECRET_KEY=
PAYSTACK_PUBLIC_KEY=

FLUTTERWAVE_PUBLIC_KEY=FLWPUBK_TEST-...
FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-...
FLUTTERWAVE_ENCRYPTION_KEY=FLWSECK_TEST...
FLUTTERWAVE_WEBHOOK_HASH=your-dashboard-webhook-secret
FLUTTERWAVE_REDIRECT_URL=https://your-frontend.com/payment/success
```

Remove (no longer used):

```env
MONNIFY_API_KEY=
MONNIFY_SECRET_KEY=
MONNIFY_CONTRACT_CODE=
MONNIFY_BASE_URL=
PAYMENT_NG_PROVIDER=monnify
```

### Payment service (`payment-service/.env`)

Same Flutterwave + Paystack keys as above. Set `PAYMENT_AFRICA_PROVIDER=flutterwave`.

### Frontend (`frontend/.env`)

```env
VITE_API_URL=http://localhost:5043
VITE_FRONTEND_URL=http://localhost:5173
VITE_FLUTTERWAVE_PUBLIC_KEY=FLWPUBK_TEST-...
```

Run `npm install` in `frontend/` after pulling (adds `flutterwave-react-v3`).

## Webhook URLs

Configure in provider dashboards:

| Provider | URL |
|----------|-----|
| Paystack | `https://{backend}/api/payments/webhooks/paystack` |
| Flutterwave | `https://{backend}/api/payments/webhooks/flutterwave` |

Set Flutterwave **secret hash** to match `FLUTTERWAVE_WEBHOOK_HASH`.

## Region detection order

1. Explicit `billingCountry` from checkout UI  
2. `countryCode` from client  
3. IP country header (`cf-ipcountry`, `x-vercel-ip-country`, etc.)

## Verification flow (unchanged security model)

1. User pays via Flutterwave or Paystack  
2. Provider webhook hits backend (signature verified)  
3. Backend re-queries provider API (`verifyProviderTransaction`)  
4. `secure_fulfill_*` RPC credits coins / activates membership once  
5. Duplicate webhooks return `duplicate: true` without double-credit  

Flutterwave verification supports transaction **ID** and **tx_ref** (order key).

## Local testing

```bash
# Terminal 1 — payment-service
cd payment-service && dotnet run

# Terminal 2 — backend
cd backend && npm run dev

# Terminal 3 — frontend
cd frontend && npm install && npm run dev
```

Test cards: use Flutterwave/Paystack sandbox docs. Confirm webhook delivery with ngrok or Render preview URLs.

## Deploy checklist

1. Apply Supabase migrations (if not already)  
2. Deploy **payment-service** with Flutterwave keys  
3. Deploy **backend** with updated env (remove Monnify)  
4. Deploy **frontend** with `VITE_FLUTTERWAVE_PUBLIC_KEY`  
5. Update provider webhook URLs  
6. Smoke-test: NG checkout (Flutterwave), US checkout (Paystack)
