# Creates the first system administrator. The temporary password is shown once in this window.
param([string]$LoginId = 'root', [string]$Name = 'Root Admin')
. (Join-Path $PSScriptRoot 'common.ps1')
Use-Tools
$wasRunning = Test-PgRunning
Start-Pg
try {
  Set-Location $RepoDir
  $env:DATABASE_URL = Get-AppUrl
  $env:OPERATOR_CODE = 'OPERATOR'
  Run (Join-Path $NodeDir 'node.exe') @('node_modules/tsx/dist/cli.mjs', 'scripts/create-system-admin.ts', $LoginId, $Name)
} finally {
  $env:DATABASE_URL = $null
  if (-not $wasRunning) { Stop-Pg }
}
