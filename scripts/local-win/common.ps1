# Shared settings for the local Windows scripts. ASCII only (Windows PowerShell 5.1 reads files without BOM as ANSI).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoDir  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$WorksDir = Split-Path $RepoDir -Parent
$ToolsDir = Join-Path $WorksDir 'tools'
$NodeDir  = Join-Path $ToolsDir 'node26'
# If an unpacked official Node 26 zip already sits next to the repository (node-v26.x.y-win-x64), use it instead.
$sharedNode = Get-ChildItem -Path $WorksDir -Directory -Filter 'node-v26.*-win-x64' -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } |
  Sort-Object { [version]($_.Name -replace '^node-v|-win-x64$', '') } -Descending | Select-Object -First 1
if ($sharedNode) { $NodeDir = $sharedNode.FullName }
$PgDir    = Join-Path $ToolsDir 'pgsql16'
$DataRoot = Join-Path $WorksDir 'stockmgmt_data'
$PgData   = Join-Path $DataRoot 'pg16'
$SecretDir = Join-Path $DataRoot 'secrets'
$PgPort   = 5433
$AppPort  = 3000
$DbName   = 'stockmgmt'

function Say([string]$msg) { Write-Host ''; Write-Host "== $msg" -ForegroundColor Cyan }

# Run a native program and stop when it fails. Output is not redirected on purpose
# (PowerShell 5.1 turns redirected stderr lines into errors).
function Run([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $exe $($arguments -join ' ')" }
}

function Write-TextFile([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

function Read-Secret([string]$name) {
  $p = Join-Path $SecretDir "$name.txt"
  if (Test-Path $p) { return ([System.IO.File]::ReadAllText($p)).Trim() }
  return $null
}

# Letters and digits only, so the value is safe inside a connection URL.
function New-Secret([int]$len = 32) {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] $len
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $sb = New-Object System.Text.StringBuilder
  foreach ($b in $bytes) { [void]$sb.Append($chars[$b % $chars.Length]) }
  return $sb.ToString()
}

function Use-Tools {
  if (-not (Test-Path (Join-Path $NodeDir 'node.exe'))) { throw "Node is not installed in $NodeDir. Run setup.cmd first." }
  if (-not (Test-Path (Join-Path $PgDir 'bin\pg_ctl.exe'))) { throw "PostgreSQL is not installed in $PgDir. Run setup.cmd first." }
  $env:Path = "$NodeDir;$(Join-Path $PgDir 'bin');$env:Path"
}

function Test-PgRunning {
  & (Join-Path $PgDir 'bin\pg_ctl.exe') -D $PgData status | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Test-PortBusy([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $c.Close() }
}

function Start-Pg {
  if (Test-PgRunning) { return }
  if (Test-PortBusy $PgPort) { throw "Port $PgPort is already used by another program. Change `$PgPort in scripts\local-win\common.ps1 before the first setup." }
  Run (Join-Path $PgDir 'bin\pg_ctl.exe') @('-D', $PgData, '-l', (Join-Path $DataRoot 'postgres.log'), '-w', 'start')
}

function Stop-Pg {
  if (Test-PgRunning) { & (Join-Path $PgDir 'bin\pg_ctl.exe') -D $PgData -m fast -w stop }
}

function Get-OwnerUrl { "postgres://postgres:$(Read-Secret 'db-owner')@127.0.0.1:$PgPort/$DbName" }
function Get-AppUrl   { "postgres://stock_app:$(Read-Secret 'db-app')@127.0.0.1:$PgPort/$DbName" }

# The production build needs junction points, which only NTFS has. On exFAT/FAT32 the app runs in development mode.
function Test-RepoOnNtfs {
  $root = [System.IO.Path]::GetPathRoot($RepoDir)
  return ((New-Object System.IO.DriveInfo $root).DriveFormat -eq 'NTFS')
}
