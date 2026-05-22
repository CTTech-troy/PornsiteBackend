# API Observability and QStash Workflows

This implementation replaces synthetic latency bars with request-derived telemetry. Every API request is measured by middleware, buffered through Upstash Redis for multi-instance safety, persisted to Supabase, and aggregated by QStash-delivered workflow endpoints.

## Folder Structure

```txt
backend/
  index.js
  .env.example
  scripts/
    create-qstash-monitoring-workflows.mjs
  src/
    config/
      qstash.js
      redis.js
      supabase.js
    controller/
      apiMonitoringWorkflow.controller.js
      apiObservability.controller.js
    middleware/
      apiMonitoring.js
      qstashSignature.js
    router/
      apiMonitoringWorkflow.route.js
      adminSystem.route.js
    services/
      apiMonitoring.service.js
  supabase/
    migrations/
      20260521120000_api_observability.sql

admin/
  src/
    api/systemApi.ts
    pages/ITOperations.tsx
```

## Environment Variables

```env
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
RENDER_BACKEND_URL=https://your-render-service.onrender.com

QSTASH_MONITORING_AGGREGATE_CRON=* * * * *
QSTASH_MONITORING_HEALTH_CRON=*/5 * * * *
QSTASH_MONITORING_INCIDENT_CRON=*/5 * * * *
QSTASH_MONITORING_DAILY_SUMMARY_CRON=5 0 * * *
QSTASH_MONITORING_WEEKLY_SUMMARY_CRON=15 0 * * 1
QSTASH_MONITORING_RETRIES=3
QSTASH_MONITORING_RETRY_DELAY=1000 * pow(2, retried)

API_MONITOR_HEALTH_CHECK_PATHS=/api/health/services,/api/config/public
API_MONITOR_ALERT_WEBHOOK_URL=
API_MONITOR_IP_HASH_SECRET=
```

Never expose QStash, Redis, Supabase service-role, or JWT secrets to frontend code.

## Backend Flow

1. `apiMonitoringMiddleware` measures actual request latency with `process.hrtime.bigint()`.
2. The middleware captures method, endpoint, status code, request size, response size, read/write type, hashed IP, user agent, timestamp, and admin/user IDs when available.
3. Request events are pushed into an Upstash Redis list so multiple Render instances share the same event buffer.
4. If Redis is unavailable, a bounded in-process queue keeps the app running without crashing.
5. QStash calls signed workflow endpoints to flush Redis events, aggregate metrics, run health checks, detect incidents, dispatch alert webhooks, and write daily/weekly summaries.
6. The admin dashboard reads `/api/admin/system/observability/*`, which is protected by `requireAdminAuth`.
7. Socket.IO supports admin-only monitoring subscriptions through `admin:api-monitoring:subscribe`, `admin:api-monitoring:update`, and `admin:api-monitoring:unsubscribe`.

## Database Schema

Run the migration:

```bash
supabase db push
```

Tables:

- `api_request_logs`: durable request-level telemetry.
- `api_metric_rollups`: minute-level aggregate metrics for charts and long-range analytics.
- `api_incidents`: automatic warning, critical, and offline incidents.
- `api_analytics_summaries`: daily and weekly summaries.

RLS is enabled on all observability tables. The backend uses the Supabase service-role key, so do not query these tables directly from the browser.

## QStash Workflows

Create or update schedules:

```bash
cd backend
npm run qstash:create-monitoring
```

Schedules created:

- `api-monitoring-aggregate`: every minute.
- `api-monitoring-health`: every 5 minutes.
- `api-monitoring-incidents`: every 5 minutes.
- `api-monitoring-daily_summary`: daily.
- `api-monitoring-weekly_summary`: weekly.

Each workflow endpoint is under:

```txt
/api/internal/qstash/monitoring/*
```

These endpoints require `Upstash-Signature` verification and raw request bodies. Unsigned requests return `401`.

## Testing

Generate traffic:

```bash
curl http://localhost:5043/api/health/services
curl http://localhost:5043/api/config/public
curl http://localhost:5043/api/not-real
```

Verify admin observability APIs:

```bash
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  http://localhost:5043/api/admin/system/observability/overview
```

Run aggregation manually from the admin API:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"rangeMinutes":10,"bucketMinutes":1}' \
  http://localhost:5043/api/admin/system/observability/aggregate
```

Verify QStash protection:

```bash
curl -i -X POST http://localhost:5043/api/internal/qstash/monitoring/aggregate
```

Expected result: `401 Missing QStash signature`.

Verify Redis buffering:

```bash
npm run check:redis
```

Then open the admin panel and go to `IT Operations`. The dashboard polls every 10 seconds and shows live API table rows, charts, incidents, slow endpoints, and paginated logs.

Optional Socket.IO subscription test:

```js
socket.emit('admin:api-monitoring:subscribe', {
  token: '<ADMIN_TOKEN>',
  range: '1h',
});
```

## Render Deployment

1. Add all environment variables in Render dashboard.
2. Set `RENDER_BACKEND_URL` to the public Render backend URL without a trailing slash.
3. Deploy backend and run Supabase migration.
4. Run `npm run qstash:create-monitoring` once from a secure machine or Render shell.
5. Confirm schedules in the Upstash QStash dashboard.
6. Confirm `/api/health/services` is public and fast enough for health checks.
7. Confirm admin panel has the backend URL configured and admin tokens work.

## Upstash Dashboard Setup

1. Create or open QStash.
2. Copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY`.
3. Use the script above to create schedules, or create them manually with the same destinations.
4. Set retries to `3` or higher for production.
5. Set a failure callback to `/api/internal/qstash/monitoring/failure`.
6. Watch QStash Events and DLQ for failed deliveries.

## Security Notes

- Monitoring admin APIs are admin-only.
- QStash workflow endpoints require signed requests.
- Raw IP addresses are not stored; `ip_hash` uses an HMAC salt.
- Redis and Supabase failures are caught and downgraded to local bounded queues.
- Observability endpoints are excluded from request capture to avoid self-amplifying dashboard traffic.
- Keep Redis/QStash tokens server-side only.

## Scaling Recommendations

- Keep Redis enabled in every production instance; it is the shared event buffer.
- Increase `API_MONITOR_REDIS_EVENTS_LIMIT` if traffic spikes exceed one minute of buffer capacity.
- Keep QStash aggregate schedule at one-minute resolution for live dashboards.
- For very high traffic, move rollup aggregation into a Postgres function and let QStash call a thin endpoint.
- Keep log retention finite. A scheduled cleanup workflow can delete old `api_request_logs` after 30-90 days while preserving rollups.
- Add `API_MONITOR_ALERT_WEBHOOK_URL` for Slack, Discord, PagerDuty, or another incident sink. Alerts are dispatched through QStash with retry/failure handling.

## References

- Upstash QStash schedules: https://upstash.com/docs/qstash/features/schedules
- Upstash QStash retries: https://upstash.com/docs/qstash/features/retry
- Upstash QStash callbacks and failure callbacks: https://upstash.com/docs/qstash/features/callbacks
- Upstash signature verification: https://upstash.mintlify.dev/docs/qstash/howto/signature
