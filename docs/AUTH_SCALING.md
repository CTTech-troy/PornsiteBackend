# Auth scaling (grounded in this codebase)

## What actually enforces uniqueness

- **Email / password identity**: **Firebase Authentication** (`auth.createUser`, client `signInWithEmailAndPassword`). Duplicate email returns `auth/email-already-exists`. No app-level bcrypt round-trip on the API for login; verification is Firebase ID tokens.
- **`public.users` (Supabase)**: Primary key is **`id` (Firebase UID text)**. Inserts are **`upsert` on `id`** so retries/idempotent writes do not create duplicate rows for the same UID.
- **Password hashing**: Handled by **Firebase** (not `bcryptjs` in the auth route). Tuning bcrypt cost does not apply to this login path.

## Current scaling limits (before horizontal scale)

1. **In-memory rate limits** (`express-rate-limit`): counts are **per Node process**. Behind multiple instances without a shared store, each instance has its own counters; effective limits scale with instance count unless you add Redis (or similar).
2. **JWT session** (`mintSessionToken`): signed with `JWT_SECRET` / `SESSION_JWT_SECRET`. Stateless; safe across instances if the same secret is configured everywhere.
3. **Cold starts** (e.g. serverless): first request after idle can be seconds; not fixed in application code—use minimum instances, warm pings, or dedicated VMs for steady latency.
4. **Firebase quotas**: High global QPS to Firebase Auth / Admin SDK is governed by Google Cloud/Firebase quotas and regions.

## Implemented in code

- **Separate rate limits** for **login** vs **signup** (signup stricter against abuse).
- **Configurable env** (see below).
- **`insertUser` → upsert** on `id` for idempotent profile rows.
- **Firestore user doc** on signup uses **`set(..., { merge: true })`** to avoid clobber races on retry.
- **Metrics** (optional): `GET /api/health/auth-metrics` when `AUTH_METRICS=1`.
- **Timing logs**: `AUTH_TIMING=1` or `AUTH_LOGIN_TIMING=1` for login/signup stages.
- **Stress helper**: `npm run stress-auth` (invalid token path; measures throughput/rate limits, not full Firebase login).

## Environment variables

| Variable | Purpose | Suggested |
|----------|---------|-----------|
| `AUTH_LOGIN_BURST_PER_MIN` | Login burst per IP per minute | 120 |
| `AUTH_LOGIN_MAX_PER_15M` | Login window per IP per 15m | 800 |
| `AUTH_SIGNUP_BURST_PER_MIN` | Signup burst per IP per minute | 15 |
| `AUTH_SIGNUP_MAX_PER_15M` | Signup window per IP per 15m | 60 |
| `AUTH_ME_MAX_PER_15M` | GET `/api/auth/me` per IP per 15m | 400 |
| `AUTH_METRICS` | Enable `/api/health/auth-metrics` | `1` in staging |
| `AUTH_TIMING` / `AUTH_LOGIN_TIMING` | Stage timing logs | `1` when profiling |
| `JWT_SECRET` or `SESSION_JWT_SECRET` | Session JWT (required in production) | Strong random |
| `REDIS_URL` | **Planned**: shared rate-limit store | Redis URL when running ≥2 API instances |

## Redis (multi-instance rate limits)

Install `redis` and `rate-limit-redis`, then wire **one Redis client** and **separate `RedisStore` instances** (distinct prefixes) per limiter—**do not** share a single store across multiple limiters. See `rate-limit-redis` docs for `sendCommand` + `prefix`.

## Horizontal scaling checklist

- [ ] Same `JWT_SECRET` on all API replicas.
- [ ] `trust proxy` already set in `index.js` for correct `req.ip` behind load balancers.
- [ ] Redis-backed rate limiting OR edge/WAF rate limits.
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
