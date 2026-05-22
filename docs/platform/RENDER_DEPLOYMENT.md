# Render Deployment Guide

Render uses the root `render.yaml` as the Blueprint entrypoint.

## First Deploy

1. Create a new Render Blueprint from this repository.
2. Confirm the services from `render.yaml`.
3. Fill every `sync: false` secret using each service `.env.render.example` file.
4. Deploy in this order if deploying manually:
   - `xstream-payment-service`
   - `xstream-ai-gateway`
   - `xstream-backend`
   - `xstream-frontend`
   - `xstream-admin`
   - `xstream-ai-worker`
5. Set `PAYMENT_SERVICE_URL`, `AI_MODERATION_SERVICE_URL`, and
   `RENDER_BACKEND_URL` to the final Render service URLs.
6. Run backend QStash schedule scripts after the backend is live.

## Health Checks

```powershell
.\backend\scripts\deploy\render-postdeploy-check.ps1 -BackendUrl https://your-backend.onrender.com -AiUrl https://your-ai.onrender.com
```

## QStash Setup

From the backend service shell or a trusted local machine:

```bash
npm run qstash:create-keepalive
npm run qstash:create-monitoring
npm run qstash:create-payouts
npm run qstash:create-ai-moderation
npm run qstash:create-monetization
```

## Persistent Storage

AI services use Render disks mounted at `/models`. Keep the app in fallback mode
until model downloads and GPU/CPU capacity have been validated.
