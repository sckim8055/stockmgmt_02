# Back up the whole database and verify that the file can actually be restored
# (restores it into a temporary database, then drops that database). Windows PowerShell.
#
#   powershell -ExecutionPolicy Bypass -File deploy\backup.ps1
#     -> deploy\backups\stockmgmt-YYYYMMDD-HHMMSS.dump
#
# This file is ASCII-only on purpose: Windows PowerShell 5.1 reads scripts without a BOM in the
# system code page, and non-ASCII text can break parsing. Explanations in Korean: docs/OPERATIONS.md.
#
# Only a file that passed the restore check gets its final name (.dump). On failure it stays as
# .partial and is neither counted nor cleaned up as a backup.
# Note: the check restores on the same database server. Restoring onto a NEW server needs the app
# role to exist first (see docs/OPERATIONS.md).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$compose = @('compose', '-f', 'compose.yaml', '--env-file', '.env')

$keep = 14
if ($env:KEEP) {
  if ($env:KEEP -notmatch '^[0-9]+$' -or [int]$env:KEEP -lt 1) { throw "KEEP must be an integer >= 1 (0 would delete the backup just made): $($env:KEEP)" }
  $keep = [int]$env:KEEP
}

New-Item -ItemType Directory -Force -Path backups | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$name = "stockmgmt-$stamp.dump"
$file = Join-Path 'backups' $name
$partial = "$file.partial"
$inDb = "/tmp/$name"
$checkDb = 'restore_check_' + ($stamp -replace '-', '_')

function Invoke-Compose {
  # Runs "docker compose ..." and fails on a non-zero exit code.
  & docker @compose @args
  if ($LASTEXITCODE -ne 0) { throw "docker compose $($args -join ' ') failed with exit code $LASTEXITCODE" }
}

try {
  # PowerShell's ">" corrupts binary output, so the dump is written inside the container and copied out.
  Invoke-Compose exec -T db pg_dump -U postgres -d stockmgmt -Fc -f $inDb
  Invoke-Compose cp "db:$inDb" $partial
  if (-not (Test-Path $partial) -or (Get-Item $partial).Length -eq 0) { throw "Backup file was not created: $partial" }

  # Restore check
  Invoke-Compose exec -T db createdb -U postgres $checkDb
  Invoke-Compose exec -T db pg_restore -U postgres -d $checkDb --no-owner --exit-on-error $inDb
  $companies = & docker @compose exec -T db psql -U postgres -d $checkDb -Atc 'SELECT count(*) FROM app.company'
  if ($LASTEXITCODE -ne 0) { throw 'Restore check failed: could not read the restored database' }
  $migrations = & docker @compose exec -T db psql -U postgres -d $checkDb -Atc 'SELECT count(*) FROM app.schema_migration'
  if ($LASTEXITCODE -ne 0) { throw 'Restore check failed: could not read the restored database' }

  Move-Item -Force $partial $file
  $size = [math]::Round((Get-Item $file).Length / 1KB)
  Write-Output "Backup OK: $file ($size KB) - restore check: $companies companies, $migrations migrations"
}
finally {
  & docker @compose exec -T db dropdb -U postgres --if-exists $checkDb 2>$null | Out-Null
  & docker @compose exec -T db rm -f $inDb 2>$null | Out-Null
}

# Retention: keep the newest $keep verified backups, ordered by the timestamp in the file name
# (not by modification time, which can differ for copied files).
Get-ChildItem backups -File |
  Where-Object { $_.Name -match '^stockmgmt-\d{8}-\d{6}\.dump$' } |
  Sort-Object Name -Descending |
  Select-Object -Skip $keep |
  Remove-Item -Force
