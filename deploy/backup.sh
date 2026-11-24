#!/usr/bin/env bash
# DB 전체를 백업하고, 그 파일이 실제로 복원되는지 확인한다(임시 DB 에 복원해 보고 지운다).
# 사용: deploy/backup.sh            → deploy/backups/stockmgmt-YYYYMMDD-HHMMSS.dump
# 복원: docs/OPERATIONS.md 의 "복원" 절.
# 윈도우에서는 deploy/backup.ps1 을 쓴다.
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE=(docker compose -f compose.yaml --env-file .env)
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="backups/stockmgmt-$STAMP.dump"

"${COMPOSE[@]}" exec -T db pg_dump -U postgres -d stockmgmt -Fc > "$FILE"
[ -s "$FILE" ] || { echo "백업 파일이 비어 있습니다: $FILE" >&2; exit 1; }

# 복원 확인: 임시 DB 에 복원하고 기업 수를 센다. 실패하면 이 스크립트가 실패한다.
CHECK_DB="restore_check_$STAMP"; CHECK_DB="${CHECK_DB//-/_}"
"${COMPOSE[@]}" exec -T db createdb -U postgres "$CHECK_DB"
trap '"${COMPOSE[@]}" exec -T db dropdb -U postgres --if-exists "$CHECK_DB" >/dev/null' EXIT
"${COMPOSE[@]}" exec -T db pg_restore -U postgres -d "$CHECK_DB" --no-owner --exit-on-error < "$FILE"
COMPANIES=$("${COMPOSE[@]}" exec -T db psql -U postgres -d "$CHECK_DB" -Atc "SELECT count(*) FROM app.company")
MIGRATIONS=$("${COMPOSE[@]}" exec -T db psql -U postgres -d "$CHECK_DB" -Atc "SELECT count(*) FROM app.schema_migration")
echo "백업 완료: $FILE ($(du -h "$FILE" | cut -f1)) — 복원 확인: 기업 ${COMPANIES}곳, 마이그레이션 ${MIGRATIONS}개"

# 오래된 백업 정리: 최근 KEEP 개만 남긴다(기본 14).
KEEP=${KEEP:-14}
ls -1t backups/stockmgmt-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f -- "$old"; done
