#!/usr/bin/env bash
# 화면(브라우저) 점검. 버리는 DB(stock_ui_smoke)와 별도 앱 역할(stock_app_ui)을 만들어 쓰고 끝나면 지운다.
# stock_app 역할과 stock_test DB 는 건드리지 않는다.
#   1) 기능 점검(smoke.py): 화면 흐름, 권한별 표시, 부서 범위, 3개 언어
#   2) 표시 점검(theme.py): 스크린샷, 글자 대비(AA), 키보드 초점, 좁은 화면 넘침, 언어 저장
#
# 필요한 것: PostgreSQL 16(관리자 접속), Python 3 + playwright(`pip install playwright`), Chrome/Chromium, `npm run build` 를 마친 상태.
# 사용:  npm run build && tests-e2e/run.sh
#   E2E_ADMIN_URL   관리자 접속 주소(기본: postgres://postgres:devpg@127.0.0.1:5432 — 개발용 기본값. 다르면 지정한다)
#   E2E_CHROME      브라우저 실행 파일(기본: /usr/bin/google-chrome)
#   E2E_PORT        앱을 띄울 포트(기본 3124)
#   SKIP_SMOKE=1    표시 점검만
# 결과물(로그·스크린샷)은 tests-e2e/.out/ 에 남는다(저장소에 올리지 않는다). 비밀번호는 실행할 때마다 새로 만들고 파일에 쓰지 않는다.
set -uo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$SRC")
DIR=$SRC/.out
mkdir -p "$DIR"
export E2E_OUT=$DIR E2E_CHROME=${E2E_CHROME:-/usr/bin/google-chrome}
DB=stock_ui_smoke
ROLE=stock_app_ui
PORT=${E2E_PORT:-3124}
ADMIN_BASE=${E2E_ADMIN_URL:-postgres://postgres:devpg@127.0.0.1:5432}
ADMIN_URL=$ADMIN_BASE/postgres
export OWNER_URL=$ADMIN_BASE/$DB
APP_PW=$(openssl rand -hex 18)
export SMOKE_PW="Smoke-$(openssl rand -hex 8)-9a"
export SMOKE_BASE=http://127.0.0.1:$PORT
SERVER_PGID=""

cleanup() {
  set +e
  if [ -n "$SERVER_PGID" ]; then kill -TERM -- -"$SERVER_PGID" 2>/dev/null; sleep 2; kill -KILL -- -"$SERVER_PGID" 2>/dev/null; fi
  psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
  psql "$ADMIN_URL" -qc "DROP ROLE IF EXISTS $ROLE"
  echo "cleanup: db/role dropped, server group ${SERVER_PGID:-none} stopped"
}
trap cleanup EXIT

# 이 스크립트는 DB 와 역할을 만들고 지운다. 이 PC 의 DB 서버에만 쓴다(운영 서버를 가리키면 실행하지 않는다).
HOSTPORT=${ADMIN_BASE##*@}
case "${HOSTPORT%%:*}" in 127.0.0.1|localhost|"[::1]") ;; *) echo "E2E_ADMIN_URL 은 이 PC(127.0.0.1/localhost)의 DB 서버여야 합니다: ${HOSTPORT%%:*}" >&2; trap - EXIT; exit 1 ;; esac
set -e
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
psql "$ADMIN_URL" -qc "CREATE DATABASE $DB"
cd "$REPO"
MIGRATION_DATABASE_URL=$OWNER_URL APP_DB_ROLE=$ROLE node scripts/migrate.mjs | tail -1
MIGRATION_DATABASE_URL=$OWNER_URL APP_DB_ROLE=$ROLE APP_DB_PASSWORD=$APP_PW node scripts/set-app-password.mjs >/dev/null
export DATABASE_URL=postgres://$ROLE:$APP_PW@${ADMIN_BASE##*@}/$DB
export OPERATOR_CODE=OPERATOR COOKIE_SECURE=false
SMOKE_SEED=$(npx tsx "$SRC/seed.ts"); export SMOKE_SEED
echo "seeded"

# 서버에는 앱 역할의 접속 주소만 넘긴다(소유자 주소와 시험용 비밀번호는 넘기지 않는다).
setsid env -u OWNER_URL -u SMOKE_PW -u SMOKE_SEED npx next start -p $PORT > "$DIR/server.log" 2>&1 < /dev/null &
SERVER_PID=$!
SERVER_PGID=$(ps -o pgid= -p $SERVER_PID | tr -d ' ')
for i in $(seq 1 60); do curl -sf -o /dev/null "$SMOKE_BASE/login" && break; sleep 1; done
echo "server up (pgid $SERVER_PGID)"
set +e

SMOKE_RC=0; THEME_RC=0
if [ "${SKIP_SMOKE:-}" != "1" ]; then
  python3 "$SRC/smoke.py" > "$DIR/smoke-run.log" 2>&1; SMOKE_RC=$?
  echo "functional smoke: rc=$SMOKE_RC ($(grep '^RESULT' "$DIR/smoke-run.log"))"
fi
python3 "$SRC/theme.py" 2>&1 | tee "$DIR/theme-run.log"; THEME_RC=${PIPESTATUS[0]}
echo "theme check: rc=$THEME_RC"
[ $SMOKE_RC -eq 0 ] && [ $THEME_RC -eq 0 ]
