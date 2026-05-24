# Troubleshooting

## Backend Fails Health Check

- Confirm `PORT=5043`.
- Confirm required secrets exist in Render.
- Check `/api/health/services` logs for Supabase, Firebase, Redis, and QStash.
- Verify `PAYMENT_SERVICE_URL` and `AI_MODERATION_SERVICE_URL`.

## Static App Loads But API Calls Fail

- Confirm `VITE_API_URL` points to the backend public URL.
- Confirm `CORS_ORIGINS` includes frontend and admin origins.
- Rebuild static services after changing `VITE_*` variables.

## AI Gateway Starts Slowly

- Use `AI_MODEL_MODE=fallback` until model cache is warm.
- Mount `/models` as a persistent disk.
- Move GPU-heavy inference to a dedicated worker service.

## QStash Requests Are Rejected

- Confirm `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY`.
- Ensure the endpoint path in the QStash schedule matches the backend URL.
- Do not add JSON parsers before raw body middleware for signed endpoints.

## Docker Compose Cannot Reach Services

- Use service names inside Compose, for example `https://pornsitebackend.onrender.com`.
- Use public URLs only from the browser or outside Docker.
- Rebuild after moving files: `docker compose -f backend/docker-compose.yml build`.

