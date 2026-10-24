<#
.SYNOPSIS
  Deploy God's Eye View to Google Cloud Run, password-gated.

.DESCRIPTION
  Cloud Run rather than static hosting because the app's whole API surface is
  Vite plugin middleware; rather than Railway because that trial has expired.

  Deploys a prebuilt image: GOOGLE_MAPS_API_KEY is baked into the browser
  bundle at build time, so the image is built locally (or by CI) with that as a
  build ARG and pushed, instead of built from source here.

.EXAMPLE
  .\scripts\deploy-cloudrun.ps1
#>
[CmdletBinding()]
param(
  [string]$Project = 'project-494b9eee-ced6-4525-aa8',
  [string]$Region  = 'us-central1',
  [string]$Service = 'gods-eye-view',
  [string]$Image   = 'us-central1-docker.pkg.dev/project-494b9eee-ced6-4525-aa8/gev/gods-eye-view:v20'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Cloud Run supplies PORT and routes to it; .env pins HOST/PORT to localhost,
# which would leave the container unreachable.
$skip = @('HOST', 'PORT')
$vars = @{}
foreach ($line in Get-Content (Join-Path $repo '.env')) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $i = $line.IndexOf('=')
  $name = $line.Substring(0, $i).Trim()
  $value = $line.Substring($i + 1).Trim()
  if (-not $name -or -not $value -or $skip -contains $name -or $value -like 'PASTE_YOUR*') { continue }
  $vars[$name] = $value
}
# HUD-summary and open-voice keys (hud-summary.js, open-voice*.js) live in the
# HUD-summary fallback keys (server/providers/openai/hud-summary.js) live in the
# Windows user environment rather than .env; carry them over without writing
# them to a file. A value in .env still wins.
foreach ($name in @('GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'FISH_API_KEY', 'DEEPINFRA_API_KEY', 'FAL_KEY')) {
  $value = [Environment]::GetEnvironmentVariable($name)
  # A shell opened before the key was set only sees it in the User scope.
  if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, 'User') }
  if (-not $vars[$name] -and $value) { $vars[$name] = $value }
}

foreach ($required in @('GEV_AUTH_USER', 'GEV_AUTH_PASSWORD', 'GOOGLE_MAPS_API_KEY')) {
  if (-not $vars[$required]) { throw "$required missing from .env - without the auth pair the deploy is PUBLIC." }
}

# Exact hostnames, read from the service's own URLs. Vite rejects unknown Host
# headers, and upstream's Host check (build/allowedHosts.js) drops suffix
# entries such as '.run.app' as a DNS-rebinding defense - a wildcard here
# allows nothing and every request is a 403. A first-ever deploy has no URLs
# yet: deploy once, then rerun this so the hosts are filled in.
$described = gcloud run services describe $Service --project $Project --region $Region --format=json 2>$null
$serviceHosts = @()
if ($LASTEXITCODE -eq 0 -and $described) {
  $urlsJson = ($described | Out-String | ConvertFrom-Json).metadata.annotations.'run.googleapis.com/urls'
  if ($urlsJson) { $serviceHosts = @($urlsJson | ConvertFrom-Json | ForEach-Object { ([uri]$_).Host }) }
}
if (-not $serviceHosts) { Write-Warning "No existing URLs for $Service; rerun after this first deploy to allow its hostnames." }
$vars['GEV_ALLOWED_HOSTS'] = ($serviceHosts -join ',')
if (-not $vars['GEV_ALLOWED_HOSTS']) { $vars.Remove('GEV_ALLOWED_HOSTS') }

# `--env-vars-file` is not accepted by this gcloud's `run deploy`, so use the
# ^DELIM^ form: values here contain commas, which the default separator splits.
if ($vars.Values | Where-Object { $_ -like '*##*' }) { throw 'A value contains the ## delimiter.' }
$envArg = '^##^' + (($vars.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '##')

Write-Host "Deploying $Service to Cloud Run ($Region)..." -ForegroundColor Cyan
gcloud run deploy $Service `
  --image $Image `
  --project $Project `
  --region $Region `
  --platform managed `
  --allow-unauthenticated `
  --memory 1Gi `
  --cpu 1 `
  --min-instances 0 `
  --max-instances 3 `
  --timeout 300 `
  --cpu-boost `
  --set-env-vars $envArg `
  --quiet
if ($LASTEXITCODE -ne 0) { throw "gcloud run deploy failed ($LASTEXITCODE)" }

$url = gcloud run services describe $Service --project $Project --region $Region --format='value(status.url)' 2>$null
if (-not $url) { throw 'Deployed but could not read the service URL.' }

# --allow-unauthenticated is deliberate: the app's own gate is the control, so
# this must answer 401. A 200 means the gate never armed and the bundle -
# which carries the Google key - is being served to anyone with the URL.
$code = try { (Invoke-WebRequest $url -TimeoutSec 30 -SkipHttpErrorCheck).StatusCode } catch { 0 }

Write-Host ""
Write-Host "URL: $url" -ForegroundColor Green
if ($code -eq 401) {
  Write-Host "GATE CLOSED (401). Sign in as $($vars['GEV_AUTH_USER']) with GEV_AUTH_PASSWORD from .env" -ForegroundColor Green
} elseif ($code -eq 200) {
  Write-Warning 'PUBLIC (200) - the auth gate did NOT arm. Do not share this URL; check GEV_AUTH_* on the service.'
} else {
  Write-Warning "Unexpected status $code - check: gcloud run services logs read $Service --region $Region"
}
