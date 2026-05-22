# Environment configuration

Secrets live **per service** (never in repo root). After changing `.env`, restart that service.

| Service | File |
|---------|------|
| Backend API | `backend/.env` |
| Payment service | `payment-service/.env` |
| Frontend | `frontend/.env` (`VITE_*` only — no server secrets) |
| Admin | `admin/.env` |
| AI gateway/worker | `ai/.env` |

## Must match across services

- `PAYMENT_SERVICE_SHARED_SECRET` — **same** in `backend/.env` and `payment-service/.env`
- `AI_WORKER_API_KEY` — **same** in `backend/.env` and `ai/.env`
- Paystack / Flutterwave keys — backend + payment-service (backend also needs `FLUTTERWAVE_WEBHOOK_HASH` for webhooks)

## Payment routing

- `PAYMENT_AFRICA_PROVIDER=flutterwave`
- `PAYMENT_DEFAULT_PROVIDER=paystack`
- Monnify variables are **removed** (deprecated)

## You still need to set manually

1. **`FLUTTERWAVE_WEBHOOK_HASH`** — from Flutterwave dashboard → Settings → Webhooks (must match `verif-hash` header)
2. **`JWT_SECRET` / `SESSION_JWT_SECRET`** — rotate in production if these were generated locally
3. **`PAYMENT_SERVICE_SHARED_SECRET`** — rotate on Render if exposed; keep backend + payment-service in sync
4. **`DATABASE_URL` or `SUPABASE_DB_PASSWORD`** — only for `npm run migrate:content-removal` CLI migrations

## Frontend / admin public vars

- `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (anon key only)
- `VITE_FLUTTERWAVE_PUBLIC_KEY` (public key only)
- `VITE_API_URL` → backend URL
- `VITE_LIVEKIT_URL` → LiveKit WebSocket URL

## Apply migrations

See `backend/docs/platform/PAYMENT_DEPLOYMENT_CHECKLIST.md` and `npm run migrate:content-removal`.
