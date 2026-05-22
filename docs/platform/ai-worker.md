# AI Worker

Render runs `xstream-ai-worker` from the shared AI Docker image with:

```bash
python -m workers.worker
```

The worker is intentionally private and long-running. It posts heartbeats to the
backend and is the future home for Redis/QStash queue consumers.

Scale it horizontally in Render by increasing instances or by splitting workers
by queue type, for example `video`, `audio`, `text`, and `fraud`.

