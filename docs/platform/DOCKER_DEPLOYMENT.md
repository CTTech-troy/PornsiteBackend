# Docker Deployment Guide

Docker assets are co-located with each service. Compose lives at `backend/docker-compose.yml`.

## Build

```powershell
.\backend\scripts\docker\build-all.ps1
```

or:

```bash
docker compose -f backend/docker-compose.yml build
```

## Start

```powershell
.\backend\scripts\docker\up.ps1
```

or:

```bash
docker compose -f backend/docker-compose.yml up -d
```

## Local URLs

- Frontend: `http://localhost:8080`
- Admin: `http://localhost:8081`
- Backend: `http://localhost:5043`
- AI Gateway: `http://localhost:8000`
- Payment Service: `http://localhost:10000`
- Nginx aggregate proxy: `http://localhost`

## Notes

- Compose expects `backend/.env` and `ai/.env` for local secrets.
- Upstash Redis and QStash are external managed services.
- AI model cache is mounted as the `ai-model-cache` Docker volume.
