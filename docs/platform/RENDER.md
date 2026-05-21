# Render Deployment

The canonical Render Blueprint is the root `render.yaml`. Render looks there by
default for Blueprints.

## Services

- `xstream-backend`: Dockerized Express API and Socket.IO server.
- `xstream-payment-service`: Dockerized C# payment service.
- `xstream-ai-gateway`: FastAPI AI gateway with a persistent `/models` disk.
- `xstream-ai-worker`: background AI worker using the same AI image.
- `xstream-frontend`: static React frontend from `frontend/`.
- `xstream-admin`: static admin dashboard from `admin/`.

## Required Manual Secrets

All sensitive values in `render.yaml` use `sync: false`. Add them in the Render
Dashboard or a Render environment group before first deploy.

Use each service `.env.render.example` file as a checklist.
