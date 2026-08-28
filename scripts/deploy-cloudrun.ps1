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
  [string]$Image   = 'us-central1-docker.pkg.dev/project-494b9eee-ced6-4525-aa8/gev/gods-eye-view:v1'
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

foreach ($required in @('GEV_AUTH_USER', 'GEV_AUTH_PASSWORD', 'GOOGLE_MAPS_API_KEY')) {
  if (-not $vars[$required]) { throw "$required missing from .env - without the auth pair the deploy is PUBLIC." }
}

# Any Cloud Run URL, so the service works before its hostname is known. Vite
# rejects unknown Host headers, which presents as a blank page on a healthy server.
$vars['GEV_ALLOWED_HOSTS'] = '.run.app'

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
  Write-Host "GATE CLOSED (401). Sign in as $($vars['GEV_AUTH_USER']) / $($vars['GEV_AUTH_PASSWORD'])" -ForegroundColor Green
} elseif ($code -eq 200) {
  Write-Warning 'PUBLIC (200) - the auth gate did NOT arm. Do not share this URL; check GEV_AUTH_* on the service.'
} else {
  Write-Warning "Unexpected status $code - check: gcloud run services logs read $Service --region $Region"
}
