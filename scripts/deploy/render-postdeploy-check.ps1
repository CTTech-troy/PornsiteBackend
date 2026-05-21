param(
  [string]$BackendUrl = $env:RENDER_BACKEND_URL,
  [string]$AiUrl = $env:AI_MODERATION_SERVICE_URL
)

if (-not $BackendUrl) {
  throw "BackendUrl or RENDER_BACKEND_URL is required."
}

$backendHealth = Invoke-RestMethod -Uri "$($BackendUrl.TrimEnd('/'))/api/health/services" -Method Get -TimeoutSec 20
Write-Output "Backend health:"
$backendHealth | ConvertTo-Json -Depth 8

if ($AiUrl) {
  $aiHealth = Invoke-RestMethod -Uri "$($AiUrl.TrimEnd('/'))/health" -Method Get -TimeoutSec 20
  Write-Output "AI health:"
  $aiHealth | ConvertTo-Json -Depth 8
}

