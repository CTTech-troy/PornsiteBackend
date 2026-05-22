# Production Architecture

The project root contains five application folders:

```txt
admin/             React admin dashboard
frontend/          React user app
backend/           Express API, Socket.IO, Redis, QStash, Supabase access
payment-service/   ASP.NET Core payment microservice
ai/                FastAPI AI gateway and AI worker/domain modules
```

Platform assets are co-located inside those apps:

```txt
backend/docker-compose.yml   Full-stack Docker Compose
backend/Dockerfile           Backend container image
backend/config/examples/     Cross-service configuration templates
backend/shared/contracts/    Shared JSON schemas
backend/docs/platform/     Operations documentation
backend/scripts/docker/    Docker helper scripts
frontend/Dockerfile        Frontend container image
frontend/nginx/            Reverse-proxy and SPA nginx configs
payment-service/Dockerfile Payment container image
ai/Dockerfile              AI gateway/worker container image
```

## Runtime Boundaries

- Frontend apps never hold backend secrets and only receive `VITE_*` variables.
- Backend owns authentication, payments, business logic, Redis, QStash, and
  database writes.
- AI services are isolated from backend source code and communicate through
  signed worker keys and internal URLs.
- Docker and Render definitions point to explicit per-service Dockerfiles.

## Production Rules

- Store secrets in Render environment groups, Docker secrets, or local ignored
  `.env` files.
- Keep Upstash Redis/QStash credentials server-side only.
- Mount AI model weights through `/models`; do not commit weights.
- Use `/api/health/services` for backend health and `/health` for AI/payment
  service health checks.
- Scale backend, AI gateway, and AI worker independently.
