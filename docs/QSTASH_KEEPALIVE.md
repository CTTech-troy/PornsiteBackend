# Upstash QStash Render Keep-Alive

This backend uses an Upstash QStash schedule to send a signed `POST` request to the Render service every 10 minutes. The request wakes the service, and the endpoint only accepts verified QStash deliveries.

## Folder Structure

```txt
backend/
|-- .env.production
|-- index.js
|-- package.json
|-- scripts/
|   `-- create-qstash-keepalive-schedule.mjs
`-- src/
    |-- config/
    |   `-- qstash.js
    |-- controller/
    |   `-- keepAlive.controller.js
    |-- middleware/
    |   `-- qstashSignature.js
    `-- router/
        `-- keepAlive.route.js
```

## Environment Variables

```env
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
RENDER_BACKEND_URL=https://your-render-service.onrender.com
QSTASH_KEEPALIVE_CRON=*/10 * * * *
QSTASH_KEEPALIVE_SCHEDULE_ID=render-backend-keepalive
QSTASH_KEEPALIVE_RETRIES=3
QSTASH_KEEPALIVE_TIMEOUT_SECONDS=15
QSTASH_KEEPALIVE_MAX_PER_MIN=30
QSTASH_CLOCK_TOLERANCE_SECONDS=60
```

Keep all QStash values server-side only. Never expose them through frontend env vars.

## Endpoints

- `POST /api/keepalive`: signed QStash delivery endpoint.
- `POST /api/keepalive/failure`: signed QStash failure callback endpoint.
- `GET /api/keepalive/status`: monitoring status, no secrets.
- `GET /api/health/services`: includes QStash configuration status.

The keep-alive routes are mounted before the general API rate limiter. They use their own small abuse limiter plus QStash signature verification.

## Create The Schedule

After setting Render environment variables and deploying:

```bash
cd backend
npm run qstash:create-keepalive
```

The script creates or updates a QStash schedule with:

- Destination: `${RENDER_BACKEND_URL}/api/keepalive`
- Cron: `*/10 * * * *`
- Method: `POST`
- Retries: `3`
- Failure callback: `${RENDER_BACKEND_URL}/api/keepalive/failure`

## Upstash Dashboard Setup

1. Open Upstash Console.
2. Go to QStash.
3. Copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY`.
4. Add them to Render environment variables.
5. Prefer running `npm run qstash:create-keepalive` for an idempotent schedule.
6. If creating manually, create a schedule:
   - URL: `https://your-render-service.onrender.com/api/keepalive`
   - Method: `POST`
   - Cron: `*/10 * * * *`
   - Header: `Content-Type: application/json`
   - Body: `{ "type": "render.keepalive", "target": "backend" }`

## Render Deployment

1. In Render, open the backend service.
2. Add the QStash env vars above.
3. Set `RENDER_BACKEND_URL` to the public Render URL, without a trailing slash.
4. Deploy the service.
5. Run the schedule creation script locally or from a one-off Render shell.
6. Watch Render logs for `[keepalive] Render backend ping accepted`.

## Testing

Unauthenticated requests should be rejected:

```bash
curl -i -X POST https://your-render-service.onrender.com/api/keepalive \
  -H "Content-Type: application/json" \
  -d '{"type":"render.keepalive"}'
```

Expected: `401` because the QStash signature is missing.

Verify configuration:

```bash
curl https://your-render-service.onrender.com/api/keepalive/status
curl https://your-render-service.onrender.com/api/health/services
```

Create the real signed schedule:

```bash
npm run qstash:create-keepalive
```

Then check Upstash QStash logs and Render logs after the next 10-minute interval.

## Troubleshooting

- `401 Missing QStash signature`: send requests through QStash, not curl/browser.
- `401 Invalid QStash signature`: confirm `RENDER_BACKEND_URL` exactly matches the public URL QStash calls.
- `503 Keep-alive verification is not configured`: set both signing keys.
- No pings in Render logs: confirm the QStash schedule is active and uses `*/10 * * * *`.
- Repeated QStash retries: check Render deploy health, custom domains, and SSL.
- Duplicate schedules: keep `QSTASH_KEEPALIVE_SCHEDULE_ID` stable and rerun the script to update the existing schedule.

## Security Notes

- The endpoint requires QStash signature verification.
- The raw request body is capped at `16kb`.
- A route-specific rate limiter blocks noisy abuse before expensive processing.
- Secrets are read only from environment variables.
- Failure callback logs are summarized to avoid dumping full payloads.

