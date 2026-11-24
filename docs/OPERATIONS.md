# 운영 안내 (한 대의 PC·서버에서 Docker 로 운영)

이 문서의 구성(`Dockerfile`, `deploy/compose.yaml`, 백업 스크립트)은 **이 개발 환경에서 Docker 로 실제 실행해 보지 못했다**
(개발 환경에 Docker 실행기가 없다). 확인한 것은: compose 파일의 문법, 마이그레이션·역할 제한 스크립트의 동작,
`pg_dump` → `pg_restore` 로 구조·정책이 그대로 복원되는 것, 운영 빌드(`next build` + `next start`)로 화면 점검이 통과하는 것이다.
처음 실행할 때 아래 "처음 실행" 의 각 단계 결과를 확인하면서 진행한다.

## 구성

| 구성 요소 | 내용 |
| --- | --- |
| `db` | PostgreSQL 16. 자료는 Docker 볼륨 `stockmgmt_pgdata` 에 남는다. PC 밖으로도, PC 안으로도 포트를 열지 않는다(앱만 접속) |
| `migrate` | 시작할 때 한 번 실행: DB 구조 적용 → 앱 역할 비밀번호 설정 → 앱 역할 실행 제한 설정. DB 소유자 계정은 여기서만 쓴다 |
| `app` | 앱 서버. 제한된 역할 `stock_app` 으로만 DB 에 접속한다. `127.0.0.1:3000` (이 PC 안)에만 열린다 |

바깥에서 접속하게 하려면 Cloudflare Tunnel 같은 터널이 `http://localhost:3000` 으로 넘겨주게 한다. 포트를 직접 열지 않는다.

## 필요한 것

- Docker Desktop (윈도우: WSL 2 방식) 또는 Docker Engine + Compose
- 이 저장소

## 처음 실행 (윈도우 PowerShell 기준)

```powershell
cd F:\works\stockmgmt_02          # 저장소를 받은 폴더

# 1) 비밀값 파일을 만든다. 메모장으로 열어 두 비밀번호를 직접 정해 넣는다(영문·숫자로 길게, @ : / ? # % 는 쓰지 않는다).
Copy-Item deploy\.env.example deploy\.env
notepad deploy\.env
#    DB_OWNER_PASSWORD  DB 소유자 비밀번호
#    DB_APP_PASSWORD    앱 전용 역할 비밀번호(16자 이상)
#    이 PC 에서 http://localhost 로만 먼저 시험한다면 COOKIE_SECURE=false 로 둔다. HTTPS(터널)로 열면 true 로 바꾼다.

# 2) 이미지를 만들고 실행한다. 처음에는 몇 분 걸린다.
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build

# 3) 확인: db 와 app 이 running(healthy), migrate 는 exited (0) 이어야 한다.
docker compose -f deploy/compose.yaml --env-file deploy/.env ps -a
docker compose -f deploy/compose.yaml --env-file deploy/.env logs migrate   # "done (N applied)" 와 비밀번호·제한 설정 문구

# 4) 첫 시스템 관리자를 만든다. 임시 비밀번호가 화면에 한 번만 나온다. 적어 둔다.
docker compose -f deploy/compose.yaml --env-file deploy/.env exec app npx tsx scripts/create-system-admin.ts root "Root Admin"

# 5) 브라우저에서 http://localhost:3000/login
#    기업코드: OPERATOR (deploy/.env 의 OPERATOR_CODE) / 아이디: root / 비밀번호: 위의 임시 비밀번호 → 새 비밀번호로 바꾼다.
#    그다음 "기업 관리"에서 기업을 만들면 그 기업 관리자의 임시 비밀번호가 나온다.
```

`deploy/.env` 는 저장소에 올라가지 않는다(`.gitignore`). 비밀번호를 채팅·메일·문서에 붙여 넣지 않는다.

## 자료 넣기

기업 관리자로 로그인해 "엑셀 업로드" 화면에서 양식을 내려받아 **직원 → 자산 → 주변기기** 순서로 올린다.
먼저 "검사"로 오류를 확인하고 "반영"한다. 한 번에 2,000행까지. 이미 있는 자산 태그·사번은 오류가 된다(덮어쓰지 않는다).

## 백업과 복원

```powershell
powershell -ExecutionPolicy Bypass -File deploy\backup.ps1
```

- `deploy\backups\stockmgmt-YYYYMMDD-HHMMSS.dump` 를 만들고, **그 파일을 임시 DB 에 복원해 보는 것까지** 한다. 복원되지 않는 백업이면 실패로 끝난다.
- 최근 14개만 남긴다(`$env:KEEP` 로 바꿀 수 있다).
- 매일 하려면 윈도우 "작업 스케줄러"에 위 명령을 등록한다(시작 위치: 저장소 폴더).
- **백업 파일은 이 PC 밖(다른 디스크·클라우드 저장소)에도 복사해 둔다.** 같은 디스크에만 있으면 디스크가 고장 날 때 함께 사라진다.
  백업 파일에는 모든 기업의 자료와 비밀번호 해시가 들어 있다. 보관 장소의 접근 권한을 제한한다.
- 리눅스·맥에서는 `deploy/backup.sh`.

복원(자료를 백업 시점으로 되돌린다. **현재 자료는 사라진다**):

```powershell
$c = @('compose', '-f', 'deploy/compose.yaml', '--env-file', 'deploy/.env')
docker @c stop app
docker @c cp deploy\backups\stockmgmt-YYYYMMDD-HHMMSS.dump db:/tmp/restore.dump
docker @c exec -T db dropdb -U postgres --if-exists stockmgmt
docker @c exec -T db createdb -U postgres stockmgmt
docker @c exec -T db pg_restore -U postgres -d stockmgmt --no-owner --exit-on-error /tmp/restore.dump
docker @c exec -T db rm -f /tmp/restore.dump
docker @c up -d          # migrate 가 다시 돌아 빠진 구조 변경과 역할 설정을 맞춘다
```

## 새 판으로 올리기

```powershell
powershell -ExecutionPolicy Bypass -File deploy\backup.ps1     # 먼저 백업
git pull
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

`migrate` 가 새 구조 변경을 적용한 뒤에 `app` 이 새 판으로 뜬다. 구조 변경은 되돌리는 스크립트가 없다. 문제가 생기면 백업으로 복원한다.

## 운영 설정

- **앱 역할의 실행 제한** (`scripts/set-role-limits.mjs`, `migrate` 가 실행): 쿼리 하나 30초, 잠금 대기 30초, 열어 둔 채 쉬는 트랜잭션 60초.
  느린 쿼리 하나가 모든 기업이 함께 쓰는 DB 연결을 오래 붙잡지 못하게 한다. `APP_STATEMENT_TIMEOUT` 등으로 바꿀 수 있다.
- **DB 연결 수** `DB_POOL_MAX` (compose 기본 10). 사용자가 늘면 올린다. PostgreSQL 의 `max_connections`(기본 100)보다 충분히 작게 둔다.
- **접속자 IP 기록** `TRUSTED_IP_HEADER`: Cloudflare Tunnel 이면 `cf-connecting-ip`. 비워 두면 IP 를 기록하지 않고, IP 기준 로그인 제한도 걸리지 않는다
  (계정 기준 잠금은 그대로 동작한다). 터널·프록시 없이 직접 열어 둔 상태에서는 설정하지 않는다(접속자가 헤더를 꾸밀 수 있다).
- **쿠키** `COOKIE_SECURE=true`(기본): HTTPS 에서만 로그인 쿠키가 전달된다. 터널이 HTTPS 를 제공하므로 운영에서는 true.
- 상태 확인용 주소는 따로 없다. 로그인 화면(`/login`)이 열리는지로 확인한다(compose 의 healthcheck 도 그렇게 한다).

## 아직 없는 것

- 정기 메일 발송과 정기 실행기(날짜 기준 알림을 시각에 맞춰 만드는 것). 일정 설정과 미리보기까지만 된다.
- 기업 비활성화 화면.
- 서버 오류 메시지·엑셀 양식의 영어·중국어.
- 자동 백업 등록과 백업의 외부 보관(위 안내대로 직접 설정한다).
- 로그 수집·경보. `docker compose logs app` 으로 직접 본다.

## 화면 점검 다시 돌리기 (개발용)

`tests-e2e/run.sh` 가 버리는 DB 를 만들어 운영 빌드를 띄우고 브라우저로 화면을 점검한다(기능 186 + 표시 189항목). 사용법은 그 파일의 머리말.
