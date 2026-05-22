# Auth scaling (grounded in this codebase)

## What actually enforces uniqueness

- **Email / password identity**: **Firebase Authentication** (`auth.createUser`, client `signInWithEmailAndPassword`). Duplicate email returns `auth/email-already-exists`. No app-level bcrypt round-trip on the API for login; verification is Firebase ID tokens.
- **`public.users` (Supabase)**: Primary key is **`id` (Firebase UID text)**. Inserts are **`upsert` on `id`** so retries/idempotent writes do not create duplicate rows for the same UID.
- **Password hashing**: Handled by **Firebase** (not `bcryptjs` in the auth route). Tuning bcrypt cost does not apply to this login path.

## Current scaling limits (before horizontal scale)

1. **Redis-backed rate limits** (`express-rate-limit` + `rate-limit-redis` + Upstash): counts are shared across Node processes when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured. If Redis is unavailable, the app falls back to a per-process memory store until Redis recovers.
2. **JWT session** (`mintSessionToken`): signed with `JWT_SECRET` / `SESSION_JWT_SECRET`. Stateless; safe across instances if the same secret is configured everywhere.
3. **Cold starts** (e.g. serverless): first request after idle can be seconds; not fixed in application code—use minimum instances, warm pings, or dedicated VMs for steady latency.
4. **Firebase quotas**: High global QPS to Firebase Auth / Admin SDK is governed by Google Cloud/Firebase quotas and regions.

## Implemented in code

- **Separate rate limits** for **login**, **signup**, **forgot/reset password**, and general API requests.
- **Configurable env** (see below).
- **`insertUser` → upsert** on `id` for idempotent profile rows.
- **Firestore user doc** on signup uses **`set(..., { merge: true })`** to avoid clobber races on retry.
- **Metrics** (optional): `GET /api/health/auth-metrics` when `AUTH_METRICS=1`.
- **Timing logs**: `AUTH_TIMING=1` or `AUTH_LOGIN_TIMING=1` for login/signup stages.
- **Stress helper**: `npm run stress-auth` (invalid token path; measures throughput/rate limits, not full Firebase login).

## Environment variables

| Variable | Purpose | Suggested |
|----------|---------|-----------|
| `AUTH_LOGIN_BURST_PER_MIN` | Login burst per IP per minute | 20 |
| `AUTH_LOGIN_MAX_PER_15M` | Login window per IP per 15m | 100 |
| `AUTH_SIGNUP_BURST_PER_MIN` | Signup burst per IP per minute | 5 |
| `AUTH_SIGNUP_MAX_PER_15M` | Signup window per IP per 15m | 25 |
| `AUTH_FORGOT_PASSWORD_BURST_PER_MIN` | Forgot/reset password burst per IP per minute | 5 |
| `AUTH_FORGOT_PASSWORD_MAX_PER_15M` | Forgot/reset password window per IP per 15m | 15 |
| `AUTH_ME_MAX_PER_15M` | GET `/api/auth/me` per IP per 15m | 400 |
| `API_GENERAL_MAX_PER_MIN` | General API requests per IP per minute | 300 |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint | From Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token | From Upstash console |
| `UPSTASH_REDIS_COMMAND_TIMEOUT_MS` | Per-command Redis timeout | 5000 |
| `RATE_LIMIT_REDIS_PREFIX` | Redis key prefix for rate limits | `xstream:rl` |
| `AUTH_METRICS` | Enable `/api/health/auth-metrics` | `1` in staging |
| `AUTH_TIMING` / `AUTH_LOGIN_TIMING` | Stage timing logs | `1` when profiling |
| `JWT_SECRET` or `SESSION_JWT_SECRET` | Session JWT (required in production) | Strong random |

## Redis (multi-instance rate limits)

Implemented in `src/config/redis.js`, `src/middleware/rateLimitStore.js`, `src/middleware/authRateLimit.js`, and `src/middleware/apiRateLimit.js`. Each limiter receives its own `RedisStore` prefix; stores are not shared across limiters.

## Horizontal scaling checklist

- [ ] Same `JWT_SECRET` on all API replicas.
- [ ] `trust proxy` already set in `index.js` for correct `req.ip` behind load balancers.
- [x] Redis-backed rate limiting through Upstash REST credentials.
- [ ] Firebase Admin credentials available on every instance.
- [ ] Optional: queue (BullMQ, Cloud Tasks) for welcome email, analytics, audit—**not** in the auth request path today.

## Monitoring

- Use `AUTH_METRICS=1` and scrape `/api/health/auth-metrics` (login/signup OK/fail, rateLimited).
- Add APM (OpenTelemetry, Datadog, etc.) for p95 on `POST /api/auth/login` and `POST /api/auth/signup`.
- Alert on 429 rate, 5xx on auth routes, and Firebase Admin errors.

## Index / migration

- `20250405130000_users_username_index.sql`: index on `lower(username)` for username lookups (email is not stored in `public.users`; Firebase is source of truth for email).

## Queue / background work (recommended next steps)

Not implemented as a running worker in-repo: enqueue after successful signup/login for **non-critical** work only (analytics, email). The API already defers Firestore + `insertUser` with `void` + `.catch` so the response is not blocked by those writes.
