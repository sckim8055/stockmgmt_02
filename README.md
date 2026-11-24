# stockmgmt_02

기업별 IT 자산 재고관리 SaaS (재구축). 여러 기업이 한 DB 를 쓰고, 기업 격리는 DB 의 행 수준 보안으로, 권한은 자체 권한 테이블로 관리한다.

- 기능: 자체 로그인, 계정·역할·부서 범위, 기준 정보, 자산(개별 이력), 주변기기(수량), 엑셀 업로드, 한계 수량·알림, 메일 일정(발송은 아직 없음), 대시보드, 이력·감사 로그, 한국어·영어·중국어.
- 운영(한 대의 PC 에서 Docker 로): [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- 설계: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · 작업 규칙: [`CLAUDE.md`](CLAUDE.md) · 단계별 검토 기록: `docs/REVIEW-phase*.md`

아래는 개발용 실행 방법이다.

## 필요한 것

- Node 24
- PostgreSQL 16

## 로컬에서 실행 (개발)

```bash
npm install

# 1) DB를 만들고 구조를 적용한다 (소유자 계정으로)
createdb stockmgmt
export MIGRATION_DATABASE_URL=postgres://postgres:<소유자 비밀번호>@localhost:5432/stockmgmt
npm run db:migrate

# 2) 앱 전용 역할(stock_app)의 비밀번호를 정한다 (16자 이상)
APP_DB_PASSWORD=<앱 비밀번호> npm run db:set-app-password

# 3) 앱 설정 (.env.example 을 .env.local 로 복사해서 채운다)
export DATABASE_URL=postgres://stock_app:<앱 비밀번호>@localhost:5432/stockmgmt
export OPERATOR_CODE=OPERATOR      # 시스템 관리자가 기업코드 칸에 넣는 값
export COOKIE_SECURE=false         # http 로컬 개발에서만 false

# 4) 첫 시스템 관리자를 만든다 (임시 비밀번호가 한 번 출력된다)
npm run admin:create-system -- root "Root Admin"

# 5) 실행
npm run dev        # http://localhost:3000/login  → 기업코드: OPERATOR
```

윈도우 PowerShell에서는 `export A=B` 대신 `$env:A="B"` 를 쓴다.

## 검사

```bash
npm run check      # 타입 검사 + 전체 테스트
```

테스트는 실제 PostgreSQL에 `stock_test` DB를 새로 만들어 마이그레이션부터 적용한다.
접속 정보가 기본값과 다르면 `TEST_ADMIN_URL`, `TEST_OWNER_URL`, `TEST_APP_URL` 로 지정한다.

화면(브라우저) 점검은 `npm run build && tests-e2e/run.sh` (Python playwright 와 Chrome 필요).

## 구조

| 경로 | 내용 |
| --- | --- |
| `db/migrations/` | DB 구조. 번호 순서로 한 번씩 적용된다 |
| `src/lib/db/context.ts` | DB 접근의 유일한 입구 (`withTenant`, `withSystem`) |
| `src/lib/auth/` | 비밀번호, 세션, 로그인, 권한 판정, 감사 로그 |
| `src/lib/http/route.ts` | 모든 API가 거치는 래퍼 |
| `src/app/api/` | API 라우트 |
| `tests/` | 격리·직접 접근·인증·API·구조 규칙 테스트 |
| `CLAUDE.md` | 코드를 추가할 때 지킬 규칙 |
| `docs/ARCHITECTURE.md` | 설계와 알려진 한계 |
