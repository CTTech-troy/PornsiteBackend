# AI Moderation Infrastructure

This implementation adds a production-oriented AI moderation pipeline for livestreams, IVI sessions, chat, uploads, fraud signals, and admin review.

## Folder Structure

```txt
backend/
  src/
    controller/aiModeration.controller.js
    router/aiModerationWorkflow.route.js
    services/aiModeration.service.js
    router/adminModeration.route.js
    config/qstash.js
  scripts/create-qstash-ai-moderation-workflows.mjs
  supabase/migrations/20260521150000_ai_moderation_infrastructure.sql
  docs/AI_MODERATION_INFRASTRUCTURE.md

admin/
  src/api/moderationApi.ts
  src/pages/AIModerator.tsx
  src/pages/AIModerationSession.tsx
  src/components/layout/Sidebar.tsx

ai-moderation-service/
  app/main.py
  Dockerfile
  requirements.txt

docker-compose.ai-moderation.yml
```

## Backend Capabilities

- Creates hidden `system_ai` sessions for livestream and IVI activity.
- Records moderation events from live comments, IVI chat, reports, gifts, and frame thumbnails.
- Queues AI inference through Redis and Upstash QStash.
- Calls the Python AI moderation service when `AI_MODERATION_SERVICE_URL` is configured.
- Falls back to local heuristics when the AI service is unavailable.
- Stores events, alerts, flagged content, reviews, risk scores, behavior profiles, fraud logs, training logs, and worker health.
- Broadcasts realtime admin events through the secured `admin:ai-moderation` Socket.IO room.
- Uses signed QStash internal endpoints for async processing, aggregation, escalation, and summaries.

## Database

Run:

```bash
supabase db push
```

Created tables:

- `ai_sessions`
- `moderation_events`
- `ai_alerts`
- `flagged_content`
- `moderation_reviews`
- `ai_risk_scores`
- `user_behavior_profiles`
- `fraud_detection_logs`
- `ai_training_logs`
- `ai_worker_health`
- `ai_moderation_rules`
- `ai_flags`

## Environment Variables

```env
AI_MODERATION_SERVICE_URL=http://127.0.0.1:8000
AI_WORKER_API_KEY=
AI_MODERATION_SERVICE_TIMEOUT_MS=12000
AI_MODERATION_REDIS_QUEUE_MAX=1000
AI_ALERT_ESCALATE_AFTER_MINUTES=20

QSTASH_AI_MODERATION_AGGREGATE_CRON=*/5 * * * *
QSTASH_AI_MODERATION_ESCALATION_CRON=*/10 * * * *
QSTASH_AI_MODERATION_SUMMARY_CRON=20 0 * * *
QSTASH_AI_MODERATION_RETRIES=3
QSTASH_AI_MODERATION_TASK_RETRIES=3
```

Keep `AI_WORKER_API_KEY`, `QSTASH_TOKEN`, and QStash signing keys server-side only.

## QStash Setup

After the backend is deployed and `RENDER_BACKEND_URL` is set:

```bash
cd backend
npm run qstash:create-ai-moderation
```

This creates scheduled workflows for:

- aggregation
- incident escalation
- daily moderation summaries

Runtime moderation tasks are also published to QStash for retry-safe inference processing.

## Python AI Service

Local fallback mode:

```bash
docker compose -f docker-compose.ai-moderation.yml up --build
```

Health check:

```bash
curl http://localhost:8000/health
```

The service exposes:

```txt
GET  /health
POST /v1/moderate
POST /v1/worker/heartbeat
POST /v1/retrain
```

Production model mapping:

- Qwen2.5-VL: frame, image, screenshot, contextual visual reasoning
- Whisper: audio transcription and voice threat signals
- Detoxify: toxicity, harassment, spam, chat abuse
- YOLOv8: weapon and suspicious-object detection
- NudeNet: nudity and NSFW classification
- Isolation Forest / PyOD: user behavior, fraud, anomalies

The included FastAPI worker is intentionally safe to run without GPU packages. Add CUDA-specific model packages in the Docker image for production inference.

## Admin Dashboard

Sidebar sections:

- AI Overview
- Live Monitoring
- Moderation Incidents
- AI Analytics
- Fraud Detection
- AI Training Center
- AI Infrastructure

Session detail pages include:

- risk progression chart
- threat timeline
- suspicious messages
- frame/audio/user behavior counters
- AI alerts and review actions
- hidden `system_ai` metadata

## Security

- Admin APIs require admin auth plus AI moderation permissions.
- Socket.IO subscription verifies the admin token before joining `admin:ai-moderation`.
- QStash endpoints require signature verification.
- Worker ingestion and heartbeat endpoints require `X-AI-Worker-Key` when `AI_WORKER_API_KEY` is set.
- Every admin alert action writes an audit log.
- Users never receive hidden AI participant metadata.

## Scaling Recommendations

- Keep Node focused on orchestration and lightweight heuristics.
- Run AI workers separately on GPU instances.
- Use Redis for active session state, queues, hot risk scores, and admin alert feeds.
- Use QStash for retryable inference tasks, aggregation, escalation, summaries, and training triggers.
- Tune frame sampling with `ai_moderation_rules.frame_sampling`.
- Add model-specific queues when worker volume grows, for example `ai:moderation:queue:vision` and `ai:moderation:queue:audio`.
- Use object storage for frame snapshots instead of sending large base64 frames through Socket.IO.

## Testing

1. Start backend and admin.
2. Start the AI service with Docker.
3. Create a live session or IVI session.
4. Send a risky chat message, for example a threat phrase in a test account.
5. Open Admin -> AI Moderation -> Live Monitoring.
6. Confirm a moderation event, risk score, and alert appear.

Manual ingest test:

```bash
curl -X POST http://localhost:5043/api/admin/moderation/ai/ingest \
  -H "Authorization: Bearer <admin-token>" \
  -H "X-AI-Worker-Key: <AI_WORKER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test-session","sessionType":"livestream","eventType":"chat_message","contentType":"chat","message":"send money off platform"}'
```

## Deployment

1. Deploy the backend with Redis, QStash, Supabase, and AI env vars.
2. Run the Supabase migration.
3. Deploy the Python AI service on a CPU or GPU host.
4. Set `AI_MODERATION_SERVICE_URL` on the backend to the service URL.
5. Run `npm run qstash:create-ai-moderation`.
6. Deploy the admin dashboard.
7. Verify `/api/admin/moderation/ai/infrastructure` shows Redis, QStash, and worker health.
