# Deploy layout

## Repo root (required)

These files must stay at the **repository root** (not inside `backend/`):

| File | Why |
|------|-----|
| `render.yaml` | [Render Blueprint](https://render.com/docs/blueprint-spec) only auto-detects `render.yaml` at the repo root |
| `.dockerignore` | Only for local compose builds of `frontend` / `admin` / `nginx` (repo-root context) |
| `.gitignore` | Monorepo-wide ignore rules |
| `.github/` | CI workflows for all apps |

## Per-app secrets (`.env`)

Never keep a monolithic `.env` at the repo root. Use one file per app:

| App | Env file |
|-----|----------|
| Backend API | `backend/.env` |
| Frontend | `frontend/.env` |
| Admin | `admin/.env` |
| AI gateway/worker | `ai/.env` |
| Payment service | `payment-service/.env` |

Local Docker Compose (`backend/docker-compose.yml`) loads `backend/.env` for the API service.

## Per-app Docker ignore

| App | File |
|-----|------|
| Backend (context `./backend`) | `backend/.dockerignore` |
| Payment service | `payment-service/.dockerignore` |
| AI | `ai/.dockerignore` |
| Frontend/admin/nginx (compose) | Root `.dockerignore` |
