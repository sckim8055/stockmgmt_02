# Starts the local database and the app. Both stop when this window is closed or Ctrl+C is pressed.
. (Join-Path $PSScriptRoot 'common.ps1')
Use-Tools
$built = Test-Path (Join-Path $RepoDir '.next\BUILD_ID')
if (-not $built -and (Test-RepoOnNtfs)) { throw 'The app is not built yet. Run setup.cmd first.' }
if (-not (Test-Path (Join-Path $RepoDir '.env.local'))) { throw 'Settings are missing. Run setup.cmd first.' }
if (Test-PortBusy $AppPort) { throw "Port $AppPort is already in use. Is the app already running in another window?" }
Start-Pg
try {
  Set-Location $RepoDir
  Say "App: http://localhost:$AppPort/login   (company code: OPERATOR)   Stop: Ctrl+C or close this window"
  # Bound to 127.0.0.1 so that other computers on the network cannot reach it.
  if ($built) {
    & (Join-Path $NodeDir 'node.exe') 'node_modules/next/dist/bin/next' 'start' '-H' '127.0.0.1' '-p' "$AppPort"
  } else {
    Write-Host 'Development mode (drive is not NTFS). The first open of each screen takes a few seconds.' -ForegroundColor Yellow
    & (Join-Path $NodeDir 'node.exe') 'node_modules/next/dist/bin/next' 'dev' '--webpack' '-H' '127.0.0.1' '-p' "$AppPort"
  }
} finally {
  Stop-Pg
}
