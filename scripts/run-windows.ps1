<#
.SYNOPSIS
  Launch God's Eye View on Windows at maximum performance.

.DESCRIPTION
  Serves the production build (minified, ~2.8x the frame rate of `npm run dev`)
  and opens it in Chrome pinned to the discrete GPU.

  The GPU flag is the single largest win on this machine: on a hybrid-graphics
  laptop Chrome silently picks the integrated adapter, which measured 55 FPS
  against 154 FPS on the RTX 3080 Ti. Passing the flag per launch keeps every
  other Chrome window on the power-saving GPU.

  The macOS helpers (dev-fresh.sh, dev-secure.sh) do not run here; this is the
  Windows equivalent.

.PARAMETER Dev
  Run the Vite dev server instead of the production build. Slower, but enables
  hot reload and the import.meta.env.DEV QA hooks the scripts/qa-*.mjs
  harnesses need.

.PARAMETER SkipBuild
  Serve the existing dist/ without rebuilding.

.EXAMPLE
  .\scripts\run-windows.ps1
  .\scripts\run-windows.ps1 -Dev
#>
[CmdletBinding()]
param(
  [switch]$Dev,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Test-Path (Join-Path $repo '.env'))) {
  throw "No .env found. Copy .env.example to .env and set GOOGLE_MAPS_API_KEY."
}

$envText = Get-Content (Join-Path $repo '.env') -Raw
if ($envText -match 'GOOGLE_MAPS_API_KEY=PASTE_YOUR') {
  Write-Warning 'GOOGLE_MAPS_API_KEY is still the placeholder - the globe will not render tiles.'
}

$port = 4173
$url = "http://localhost:$port"

if ($Dev) {
  $serve = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','dev','--','--host','localhost','--port',"$port") -PassThru -NoNewWindow
} else {
  if (-not $SkipBuild) {
    Write-Host 'Building production bundle...' -ForegroundColor Cyan
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
  }
  $serve = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','preview','--','--port',"$port") -PassThru -NoNewWindow
}

Write-Host "Waiting for $url ..." -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds(90)
do {
  Start-Sleep -Milliseconds 500
  $up = try { (Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200 } catch { $false }
} until ($up -or (Get-Date) -gt $deadline)

if (-not $up) {
  if (-not $serve.HasExited) { Stop-Process -Id $serve.Id -Force }
  throw "Server did not become ready at $url"
}

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) {
  Start-Process -FilePath $chrome -ArgumentList @('--force-high-performance-gpu', $url)
  Write-Host "Opened $url in Chrome on the discrete GPU." -ForegroundColor Green
  Write-Host 'Verify at chrome://gpu - "GL Renderer" should name the NVIDIA adapter.' -ForegroundColor DarkGray
} else {
  Write-Warning "Chrome not found; open $url manually (integrated GPU will be slower)."
}

Write-Host "Server PID $($serve.Id). Press Ctrl+C to stop." -ForegroundColor DarkGray
Wait-Process -Id $serve.Id
