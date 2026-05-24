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

- Frontend: `https://xstreamvideos.site`
- Admin: `https://admin.xstreamvideos.site`
- Backend: `https://pornsitebackend.onrender.com`
- AI Gateway: `https://pornsitebackend.onrender.com`
- Payment Service: `https://payments.xstreamvideos.site`
- Nginx aggregate proxy: `https://xstreamvideos.site`

## Notes

- Compose expects `backend/.env` and `ai/.env` for local secrets.
- Upstash Redis and QStash are external managed services.
- AI model cache is mounted as the `ai-model-cache` Docker volume.

