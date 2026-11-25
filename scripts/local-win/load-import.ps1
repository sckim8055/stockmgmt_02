# Loads the prepared upload files (F:\works\stockmgmt_import by default) into the running local app.
# The app must be running (start.cmd). Passwords are written to stockmgmt_data\secrets\accounts.txt, not shown here.
param([string]$ImportDir)
. (Join-Path $PSScriptRoot 'common.ps1')
Use-Tools
if (-not $ImportDir) { $ImportDir = Join-Path $WorksDir 'stockmgmt_import' }
if (-not (Test-Path (Join-Path $ImportDir 'load.json'))) { throw "load.json was not found in $ImportDir" }
if (-not (Test-PgRunning)) { throw 'The local database is not running. Start the app with start.cmd first and leave that window open.' }
Set-Location $RepoDir
$env:STOCK_BASE_URL = "http://127.0.0.1:$AppPort"
$env:STOCK_IMPORT_DIR = $ImportDir
$env:STOCK_SECRETS_DIR = $SecretDir
Run (Join-Path $NodeDir 'node.exe') @('scripts/local-win/load-import.mjs')
