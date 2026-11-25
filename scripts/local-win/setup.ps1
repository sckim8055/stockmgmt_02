# Installs portable Node 26 and PostgreSQL 16 next to the repository and prepares the database.
# Safe to run again: finished steps are skipped, and it also applies new migrations and rebuilds.
#   F:\works\tools\node26, F:\works\tools\pgsql16   programs (nothing is installed into Windows)
#   F:\works\stockmgmt_data                         database files, log, generated passwords
param(
  # Official EnterpriseDB download of the PostgreSQL 16 Windows x64 binaries (zip).
  [string]$PgUrl = 'https://sbp.enterprisedb.com/getfile.jsp?fileid=1260731'
)
. (Join-Path $PSScriptRoot 'common.ps1')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Expand-Zip([string]$zip, [string]$dest) {
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  New-Item -ItemType Directory -Force $dest | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  # -m: do not restore file times (tar.exe fails with "Can't restore time" on some drives)
  if (Test-Path $tar) { Run $tar @('-xmf', $zip, '-C', $dest) } else { Expand-Archive -Path $zip -DestinationPath $dest -Force }
}

New-Item -ItemType Directory -Force $ToolsDir, $DataRoot, $SecretDir | Out-Null
$tmp = Join-Path $ToolsDir '_download'
New-Item -ItemType Directory -Force $tmp | Out-Null

# ---- 1. Node 26 (nodejs.org, checked against the published SHA-256) ----
if (Test-Path (Join-Path $NodeDir 'node.exe')) {
  Say "Node already installed: $(& (Join-Path $NodeDir 'node.exe') -v)"
} else {
  Say 'Downloading Node 26 from nodejs.org'
  $base = 'https://nodejs.org/dist/latest-v26.x'
  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
  if ($sums -is [byte[]]) { $sums = [System.Text.Encoding]::ASCII.GetString($sums) }
  $m = [regex]::Match($sums, '(?m)^([0-9a-f]{64})\s+(node-v26\.\d+\.\d+-win-x64\.zip)\s*$')
  if (-not $m.Success) { throw 'Could not find the Windows x64 zip in SHASUMS256.txt' }
  $hash = $m.Groups[1].Value; $file = $m.Groups[2].Value
  $zip = Join-Path $tmp $file
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $hash) { throw "SHA-256 mismatch for $file (expected $hash, got $actual). The file was not used." }
  Write-Host "SHA-256 ok: $file"
  $x = Join-Path $tmp 'node'
  Expand-Zip $zip $x
  Move-Item (Join-Path $x ($file -replace '\.zip$', '')) $NodeDir
  Say "Node installed: $(& (Join-Path $NodeDir 'node.exe') -v)"
}

# ---- 2. PostgreSQL 16 (EnterpriseDB binaries; no checksum is published, so the version is checked) ----
$pgBin = Join-Path $PgDir 'bin'
if (Test-Path (Join-Path $pgBin 'postgres.exe')) {
  Say "PostgreSQL already installed: $(& (Join-Path $pgBin 'postgres.exe') --version)"
} else {
  Say 'Downloading PostgreSQL 16 from EnterpriseDB (about 300 MB)'
  $zip = Join-Path $tmp 'postgresql-16-windows-x64-binaries.zip'
  Invoke-WebRequest -UseBasicParsing $PgUrl -OutFile $zip
  $x = Join-Path $tmp 'pg'
  Expand-Zip $zip $x
  $exe = Join-Path $x 'pgsql\bin\postgres.exe'
  if (-not (Test-Path $exe)) { throw 'The downloaded file is not a PostgreSQL binaries zip (pgsql\bin\postgres.exe is missing).' }
  $ver = & $exe --version
  if ($LASTEXITCODE -ne 0 -or -not $ver) { throw 'postgres.exe does not start. Install the Microsoft Visual C++ Redistributable (x64) and run setup again.' }
  if ($ver -notmatch '\s16\.\d+') { throw "Expected PostgreSQL 16 but downloaded: $ver. Nothing was installed. Pass the right link with -PgUrl." }
  Move-Item (Join-Path $x 'pgsql') $PgDir
  Say "PostgreSQL installed: $ver"
}

Use-Tools

# ---- 3. Database cluster with generated passwords (never printed) ----
if (-not (Read-Secret 'db-owner')) { Write-TextFile (Join-Path $SecretDir 'db-owner.txt') (New-Secret 32) }
if (-not (Read-Secret 'db-app'))   { Write-TextFile (Join-Path $SecretDir 'db-app.txt')   (New-Secret 32) }

if (Test-Path (Join-Path $PgData 'PG_VERSION')) {
  Say 'Database files already exist'
} else {
  Say 'Creating the database files'
  if (Test-PortBusy $PgPort) { throw "Port $PgPort is already used by another program. Change `$PgPort in scripts\local-win\common.ps1 and run setup again." }
  Run (Join-Path $pgBin 'initdb.exe') @('-D', $PgData, '-U', 'postgres', "--pwfile=$(Join-Path $SecretDir 'db-owner.txt')", '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C')
  Add-Content -Path (Join-Path $PgData 'postgresql.conf') -Encoding ASCII -Value @(
    '', '# stockmgmt local setup', "port = $PgPort", "listen_addresses = '127.0.0.1'", "timezone = 'UTC'")
}

Start-Pg
try {
  $env:PGPASSWORD = Read-Secret 'db-owner'
  $exists = & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $PgPort -U postgres -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$DbName'"
  if ($LASTEXITCODE -ne 0) { throw 'Could not connect to the local database.' }
  if ($exists -ne '1') {
    Say "Creating database $DbName"
    Run (Join-Path $pgBin 'createdb.exe') @('-h', '127.0.0.1', '-p', "$PgPort", '-U', 'postgres', $DbName)
  }
  $env:PGPASSWORD = $null

  # ---- 4. Packages, schema, app role ----
  Set-Location $RepoDir
  Say 'Installing packages (npm ci)'
  Run (Join-Path $NodeDir 'npm.cmd') @('ci', '--no-audit', '--no-fund')

  Say 'Applying migrations'
  $env:MIGRATION_DATABASE_URL = Get-OwnerUrl
  $env:APP_DB_PASSWORD = Read-Secret 'db-app'
  Run (Join-Path $NodeDir 'node.exe') @('scripts/migrate.mjs')
  Run (Join-Path $NodeDir 'node.exe') @('scripts/set-app-password.mjs')
  Run (Join-Path $NodeDir 'node.exe') @('scripts/set-role-limits.mjs')
  $env:MIGRATION_DATABASE_URL = $null
  $env:APP_DB_PASSWORD = $null

  # ---- 5. App settings (.env.local is ignored by git; the owner password is not put here) ----
  Write-TextFile (Join-Path $RepoDir '.env.local') (@(
    '# Written by scripts/local-win/setup.ps1. Local use only.',
    "DATABASE_URL=$(Get-AppUrl)",
    'OPERATOR_CODE=OPERATOR',
    'COOKIE_SECURE=false',
    'TRUSTED_IP_HEADER=',
    'HASH_CONCURRENCY=4', '') -join "`n")

  Say 'Building the app'
  Run (Join-Path $NodeDir 'npm.cmd') @('run', 'build')
} finally {
  $env:PGPASSWORD = $null
  Stop-Pg
}

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Say 'Setup finished.'
Write-Host 'Next:  1) create-admin.cmd (first time only)   2) start.cmd   3) open http://localhost:3000/login'
