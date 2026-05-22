# Central Configuration

This folder contains deployable configuration examples only. Runtime secrets stay
in each platform's secret manager, Render environment group, or local `.env`
files that are ignored by git.

- `env/`: development, staging, and production environment templates.
- `redis.config.example.json`: Upstash Redis cache and queue settings.
- `qstash.config.example.json`: QStash retry, signature, and schedule settings.
- `ai.config.example.json`: AI service routing and model-loading settings.
- `websocket.config.example.json`: Socket.IO CORS and scaling settings.
- `database.config.example.json`: Supabase/Postgres runtime settings.

The backend still owns its runtime loaders in `backend/src/config` so existing
functionality remains stable. These files are the cross-service source of truth
for deployment and operations.

