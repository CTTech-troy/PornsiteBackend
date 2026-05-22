# Upstash Redis Rate Limiting

This backend uses `express-rate-limit` with `rate-limit-redis` and Upstash Redis REST credentials. When Redis is configured, counters are shared across every Node/Express instance. If Redis is missing or temporarily unavailable, the middleware falls back to an in-memory per-process store so the app keeps serving requests.

## Folder Structure

```txt
backend/
|-- .env.example
|-- index.js
|-- package.json
|-- scripts/
|   `-- check-upstash-redis.mjs
`-- src/
    |-- config/
    |   `-- redis.js
    `-- middleware/
        |-- apiRateLimit.js
        |-- authRateLimit.js
        `-- rateLimitStore.js
```

## Environment

```env
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
UPSTASH_REDIS_COMMAND_TIMEOUT_MS=5000
UPSTASH_REDIS_RETRIES=2
RATE_LIMIT_REDIS_PREFIX=xstream:rl
RATE_LIMIT_REDIS_FALLBACK_COOLDOWN_MS=30000
```

Keep these values only in server-side environment variables. Do not prefix them with frontend-public names such as `VITE_`, `NEXT_PUBLIC_`, or similar.

## Limits

| Route group | Default limit |
| --- | --- |
| General `/api/*` | `300/min` |
| `POST /api/auth/login` | `20/min` burst and `100/15m` |
| `POST /api/auth/signup` | `5/min` burst and `25/15m` |
| `POST /api/auth/forgot-password` | `5/min` burst and `15/15m` |
| `POST /api/auth/reset-password` | `5/min` burst and `15/15m` |
| `GET /api/auth/me` | `400/15m` |

All limits are configurable through `.env.example`.

## Verify Redis

```bash
npm run check:redis
curl http://localhost:5043/api/health/redis
curl http://localhost:5043/api/health/services
```

A healthy Redis response has `"configured": true` and `"connected": true`.

## Test Rate Limiting

Temporarily lower a limit in `.env`:

```env
AUTH_LOGIN_BURST_PER_MIN=2
```

Restart the backend, then run:

```bash
for i in 1 2 3; do
  curl -i -X POST http://localhost:5043/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"wrong-password"}'
done
```

The request over the limit should return `429` with `RateLimit-*` headers.

## Production Deployment

1. Create an Upstash Redis database in the same region as the API when possible.
2. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the production secret manager.
3. Set the same `JWT_SECRET` / `SESSION_JWT_SECRET` on every API instance.
4. Keep `TRUST_PROXY_HOPS=1` or adjust it to match the load balancer chain so `req.ip` is correct.
5. Deploy, then run `npm run check:redis` or request `/api/health/redis`.
6. Alert on sustained `429` spikes and on Redis health returning `connected: false`.

The previous TCP Redis URL startup warning has been removed because this app now uses Upstash REST credentials instead of a TCP Redis URL.
