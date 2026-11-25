# stockmgmt_02 작업 규칙

기업별 IT 자산 재고관리 SaaS. 여러 기업의 데이터가 한 DB에 있으므로 **기업 격리와 권한 검사가 깨지면 서비스 전체가 사고**다.
아래 규칙은 `tests/guard.test.ts` 와 통합 테스트가 강제한다. 테스트를 고쳐서 통과시키지 말고 코드를 규칙에 맞춘다.

## 반드시 지킬 것

1. **API 라우트는 `route()` 로만 만든다** (`src/lib/http/route.ts`). 형태는 `export const GET = route(...)` 뿐이다.
   - Server Action(`'use server'`)은 쓰지 않는다. `route()` 를 거치지 않는 서버 진입점이 되기 때문이다.
   - 업무 API는 `access: 'permission'` 과 `{ resource, operation }` 을 선언한다. 리소스 코드는 `db/migrations/0003_seed_permissions.sql` 에 있는 것만 쓴다.
   - `access: 'public'` 과 `withSystem` 은 허용 목록(`tests/guard.test.ts`)에 있는 파일에서만 쓴다. 목록을 늘려야 하면 작업을 멈추고 검토를 요청한다.
2. **DB 접근은 핸들러가 받은 `tenant(fn)` 으로만 한다.** 기업 ID는 세션에서만 온다. 요청 본문·쿼리·헤더의 기업 ID를 쓰지 않는다.
3. **SQL은 `$1, $2` 매개변수만 쓴다.** 템플릿 문자열에 값을 끼워 넣지 않는다. 정렬·검색 컬럼은 허용 목록에서 고른다.
   - `.query()` 의 첫 인자는 그 자리에 쓴 문자열이거나 `SQL_` 로 시작하는 모듈 상수여야 한다.
   - `set_config`, `SET ROLE`, `SET app.*` 로 DB 문맥을 직접 바꾸지 않는다.
   - `db` 핸들을 트랜잭션 밖으로 들고 나가지 않는다. `forEach(async ...)` 처럼 await 가 빠지는 코드를 쓰지 않는다
     (끝난 핸들을 쓰면 예외가 난다). 쿼리 오류를 try/catch 로 삼키지 않는다.
   - `app.app_user` 는 `SELECT *` 할 수 없다(`password_hash` 는 읽기 권한이 없다). 필요한 컬럼을 적는다.
4. **화면에 `dangerouslySetInnerHTML`, `innerHTML` 을 쓰지 않는다.**
5. **DB 구조는 `db/migrations/` 에 새 번호의 파일을 추가해서만 바꾼다.** 이미 배포된 마이그레이션 파일은 고치지 않는다.
   - `company_id` 가 있는 새 테이블은 RLS와 `tenant_isolation` 정책, `stock_app` 권한을 같은 마이그레이션에서 준다.
   - 앱 역할 이름은 항상 `stock_app` 으로 적는다(실행할 때 `APP_DB_ROLE` 로 치환된다).
   - `app_user` 에 컬럼을 추가하면 그 컬럼의 `GRANT SELECT (컬럼)` 도 함께 준다.
   - 다른 기업 행을 참조할 수 없게 `(id, company_id)` 복합 외래키를 쓴다.
   - CHECK 제약에서 NULL 가능한 컬럼에 `IN (...)` 을 쓸 때는 `IS NOT NULL` 을 함께 건다(NULL 이면 통과해 버린다).
6. **환경변수는 `src/lib/env.ts` 에서만 읽는다.** 비밀값을 코드·로그·감사 로그에 남기지 않는다.
7. **자산·계정·기업·직원은 삭제하지 않는다.** 상태 변경 또는 비활성화로 처리한다. 이력·감사 테이블은 추가만 한다.

## 검토 없이 고치면 안 되는 파일

`src/lib/db/*`, `src/lib/auth/*`, `src/lib/http/cookies.ts`, `src/lib/http/route.ts`, `db/migrations/0001~0004`, `tests/guard.test.ts`,
`tests/isolation.test.ts`, `tests/direct-access.test.ts`, `tests/hardening.test.ts`. 수정이 필요하면 이유를 적고 검토를 요청한다.

## 작업 방법

- Node 26(24 도 동작), PostgreSQL 16. 실행 방법은 `README.md`.
- 끝내기 전에 `npm run check` (타입 검사 + 전체 테스트) 가 통과해야 한다. 새 API를 만들면 `tests/` 에
  "다른 기업 계정으로 호출하면 안 보인다", "권한 없는 계정은 403" 테스트를 함께 추가한다.
- 설계 배경은 `docs/ARCHITECTURE.md`.
