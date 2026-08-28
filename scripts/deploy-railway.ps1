<#
.SYNOPSIS
  Deploy God's Eye View to Railway, password-gated, in one command.

.DESCRIPTION
  Run `railway login` once first (browser OAuth; cannot be automated). Then this
  script links a project, pushes every variable from .env, deploys, and verifies
  the gate is closed.

.EXAMPLE
  railway login
  .\scripts\deploy-railway.ps1
#>
[CmdletBinding()]
param([string]$ProjectName = 'gods-eye-view')

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Get-Command railway -ErrorAction SilentlyContinue)) { throw 'Railway CLI missing: npm i -g @railway/cli' }
railway whoami *> $null
if ($LASTEXITCODE -ne 0) { throw 'Not logged in. Run: railway login' }

# Parse .env, ignoring comments and blank lines.
$envVars = @{}
foreach ($line in Get-Content (Join-Path $repo '.env')) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $name, $value = $line -split '=', 2
  $name = $name.Trim(); $value = $value.Trim()
  if ($name -and $value) { $envVars[$name] = $value }
}

foreach ($required in @('GOOGLE_MAPS_API_KEY', 'GEV_AUTH_USER', 'GEV_AUTH_PASSWORD')) {
  if (-not $envVars[$required] -or $envVars[$required] -like 'PASTE_YOUR*') {
    throw "$required is missing from .env. Without the auth pair the deploy is PUBLIC."
  }
}

# HOST/PORT come from the platform, not the local file: .env pins them to
# localhost:4173, which would make the container unreachable.
'HOST', 'PORT' | ForEach-Object { $envVars.Remove($_) }

if (-not (Test-Path (Join-Path $repo '.railway'))) {
  Write-Host "Creating Railway project '$ProjectName'..." -ForegroundColor Cyan
  railway init --name $ProjectName
  if ($LASTEXITCODE -ne 0) { throw 'railway init failed' }
}

Write-Host "Pushing $($envVars.Count) variables..." -ForegroundColor Cyan
$pairs = $envVars.GetEnumerator() | ForEach-Object { '--set'; "$($_.Key)=$($_.Value)" }
railway variables @pairs | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to set variables' }

Write-Host 'Deploying (build runs on Railway; first one takes a few minutes)...' -ForegroundColor Cyan
railway up --detach
if ($LASTEXITCODE -ne 0) { throw 'railway up failed' }

$domain = (railway domain 2>&1 | Select-String -Pattern '[a-z0-9.-]+\.(up\.railway\.app|railway\.app)' |
  ForEach-Object { $_.Matches[0].Value } | Select-Object -First 1)
if (-not $domain) { Write-Warning 'No domain yet. Run `railway domain` to generate one, then re-run the checks below.'; return }

$url = "https://$domain"
Write-Host "`nDeployed: $url" -ForegroundColor Green
Write-Host 'Waiting for the first response...' -ForegroundColor DarkGray

$deadline = (Get-Date).AddMinutes(10)
do {
  Start-Sleep -Seconds 10
  $code = try { (Invoke-WebRequest $url -TimeoutSec 10 -SkipHttpErrorCheck).StatusCode } catch { 0 }
} until ($code -ne 0 -or (Get-Date) -gt $deadline)

# A 200 here means the gate never armed and the bundle - which carries the
# Google key - is being served to anyone with the URL.
if ($code -eq 401) {
  Write-Host "GATE CLOSED (401). Sign in as $($envVars['GEV_AUTH_USER']) / $($envVars['GEV_AUTH_PASSWORD'])" -ForegroundColor Green
} elseif ($code -eq 200) {
  Write-Warning "PUBLIC (200) - the auth gate did NOT arm. Check GEV_AUTH_* in `railway variables` before sharing this URL."
} else {
  Write-Warning "Unexpected status $code - check `railway logs`."
}
