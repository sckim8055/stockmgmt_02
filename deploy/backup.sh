#!/usr/bin/env bash
# DB 전체를 백업하고, 그 파일이 실제로 복원되는지 확인한다(임시 DB 에 복원해 보고 지운다).
# 사용: deploy/backup.sh            → deploy/backups/stockmgmt-YYYYMMDD-HHMMSS.dump
# 복원: docs/OPERATIONS.md 의 "복원" 절. 윈도우에서는 deploy/backup.ps1.
#
# 복원 확인을 통과한 파일만 최종 이름(.dump)을 얻는다. 실패하면 .partial 로 남고 정리 대상·"최근 백업"에 들어가지 않는다.
# 주의: 복원 확인은 같은 DB 서버에서 한다. 새 서버에 복원할 때는 앱 역할이 먼저 있어야 한다(docs/OPERATIONS.md).
set -euo pipefail
umask 077   # 백업에는 모든 기업의 자료와 비밀번호 해시가 들어 있다. 만든 사람만 읽게 한다.
cd "$(dirname "$0")"
COMPOSE=(docker compose -f compose.yaml --env-file .env)

KEEP=${KEEP:-14}
case "$KEEP" in ''|*[!0-9]*) echo "KEEP 은 1 이상의 정수여야 합니다: $KEEP" >&2; exit 1 ;; esac
[ "$KEEP" -ge 1 ] || { echo "KEEP 은 1 이상이어야 합니다(0 이면 방금 만든 백업까지 지워진다)." >&2; exit 1; }

mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="backups/stockmgmt-$STAMP.dump"
PARTIAL="$FILE.partial"
CHECK_DB="restore_check_${STAMP//-/_}"
cleanup() { "${COMPOSE[@]}" exec -T db dropdb -U postgres --if-exists "$CHECK_DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${COMPOSE[@]}" exec -T db pg_dump -U postgres -d stockmgmt -Fc > "$PARTIAL"
[ -s "$PARTIAL" ] || { echo "백업 파일이 비어 있습니다: $PARTIAL" >&2; exit 1; }

# 복원 확인: 임시 DB 에 복원하고 기업 수를 센다. 하나라도 실패하면 이 스크립트가 실패한다(set -e).
"${COMPOSE[@]}" exec -T db createdb -U postgres "$CHECK_DB"
"${COMPOSE[@]}" exec -T db pg_restore -U postgres -d "$CHECK_DB" --no-owner --exit-on-error < "$PARTIAL"
COMPANIES=$("${COMPOSE[@]}" exec -T db psql -U postgres -d "$CHECK_DB" -Atc "SELECT count(*) FROM app.company")
MIGRATIONS=$("${COMPOSE[@]}" exec -T db psql -U postgres -d "$CHECK_DB" -Atc "SELECT count(*) FROM app.schema_migration")
mv -- "$PARTIAL" "$FILE"
echo "백업 완료: $FILE ($(du -h "$FILE" | cut -f1)) — 복원 확인: 기업 ${COMPANIES}곳, 마이그레이션 ${MIGRATIONS}개"

# 오래된 백업 정리: 이름(= 만든 시각)순으로 최근 KEEP 개만 남긴다. 파일의 수정 시각은 쓰지 않는다(복사해 온 파일은 시각이 다를 수 있다).
ls -1 backups/ | grep -E '^stockmgmt-[0-9]{8}-[0-9]{6}\.dump$' | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do rm -f -- "backups/$old"; done
