# DB 전체를 백업하고, 그 파일이 실제로 복원되는지 확인한다(임시 DB 에 복원해 보고 지운다). 윈도우 PowerShell 용.
# 사용: powershell -ExecutionPolicy Bypass -File deploy\backup.ps1
#   → deploy\backups\stockmgmt-YYYYMMDD-HHMMSS.dump
# 매일 실행하려면 "작업 스케줄러"에 이 명령을 등록한다(docs/OPERATIONS.md).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$compose = @('compose', '-f', 'compose.yaml', '--env-file', '.env')
New-Item -ItemType Directory -Force -Path backups | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$name = "stockmgmt-$stamp.dump"
$file = Join-Path 'backups' $name
$inDb = "/tmp/$name"

# PowerShell 의 > 는 바이너리를 망가뜨린다. 컨테이너 안에 만든 뒤 꺼내 온다.
docker @compose exec -T db pg_dump -U postgres -d stockmgmt -Fc -f $inDb
if ($LASTEXITCODE -ne 0) { throw 'pg_dump 실패' }
docker @compose cp "db:$inDb" $file
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $file) -or (Get-Item $file).Length -eq 0) { throw "백업 파일을 만들지 못했습니다: $file" }

# 복원 확인
$checkDb = "restore_check_" + ($stamp -replace '-', '_')
try {
  docker @compose exec -T db createdb -U postgres $checkDb
  if ($LASTEXITCODE -ne 0) { throw '임시 DB 를 만들지 못했습니다' }
  docker @compose exec -T db pg_restore -U postgres -d $checkDb --no-owner --exit-on-error $inDb
  if ($LASTEXITCODE -ne 0) { throw '복원 확인 실패: 이 백업 파일은 복원되지 않습니다' }
  $companies = docker @compose exec -T db psql -U postgres -d $checkDb -Atc "SELECT count(*) FROM app.company"
  $migrations = docker @compose exec -T db psql -U postgres -d $checkDb -Atc "SELECT count(*) FROM app.schema_migration"
  $size = [math]::Round((Get-Item $file).Length / 1KB)
  Write-Output "백업 완료: $file (${size} KB) — 복원 확인: 기업 ${companies}곳, 마이그레이션 ${migrations}개"
}
finally {
  docker @compose exec -T db dropdb -U postgres --if-exists $checkDb | Out-Null
  docker @compose exec -T db rm -f $inDb | Out-Null
}

# 오래된 백업 정리: 최근 14개만 남긴다.
$keep = if ($env:KEEP) { [int]$env:KEEP } else { 14 }
Get-ChildItem backups -Filter 'stockmgmt-*.dump' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $keep | Remove-Item -Force
