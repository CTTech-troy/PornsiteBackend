$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
docker compose -f (Join-Path $root "backend\docker-compose.yml") build

