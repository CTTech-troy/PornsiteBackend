# Scaling Guide

## Backend

- Run multiple backend instances behind Render or nginx.
- Keep rate limits, API monitoring, QStash workflows, and session state backed
  by Upstash Redis so instances remain stateless.
- Use `TRUST_PROXY_HOPS=1` on Render.

## AI

- Scale `xstream-ai-worker` horizontally before scaling the gateway.
- Split workers by queue when traffic grows: `video`, `audio`, `text`, `fraud`.
- Use `/models` disks or a model registry for large weights.
- Keep lazy model loading enabled to reduce cold-start pressure.

## Frontend/Admin

- Serve as static sites with long-lived immutable asset caching.
- Keep API URLs in `VITE_*` env vars and never expose server secrets.

## Redis and QStash

- Use QStash for scheduled jobs, retries, and workflow delivery.
- Use Redis for live state, event fanout, rate limiting, and short TTL caches.
- Keep workflow endpoints signed and raw-body verified.

