-- 행 수준 보안(RLS) 아래에서 인덱스를 쓰지 못하던 조회를 고친다.
--
-- 배경(0008 과 같다): 앱 역할에는 RLS 가 걸려 있어, 조건에 "누설 방지"가 아닌 함수나 연산자
-- (lower(), ->>, ? 등)가 들어 있으면 PostgreSQL 이 그 조건을 인덱스 조건으로 쓰지 못한다.
-- 표현식 인덱스가 있어도 기업의 행 전체(또는 테이블 전체)를 훑는다.
-- 값을 저장된 열로 빼 두면 평범한 `=` 비교가 되어 인덱스를 쓴다.

-- 1) 알림의 중복 방지 열쇠. 날짜 기준 알림이 "이미 알린 건"을 뺄 때 기업의 알림 전체를 읽던 것을 고친다.
ALTER TABLE app.notification ADD COLUMN dedupe_key text GENERATED ALWAYS AS (payload ->> 'key') STORED;
DROP INDEX app.notification_dedupe_key;
DROP INDEX app.notification_company_key_idx;
CREATE UNIQUE INDEX notification_dedupe_key ON app.notification (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notification_company_key_idx ON app.notification (company_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- 2) 사번 조회. 중복 검사와 엑셀 업로드의 보유자 찾기가 person 테이블 전체(다른 기업 행 포함)를 훑던 것을 고친다.
ALTER TABLE app.person ADD COLUMN employee_no_key text GENERATED ALWAYS AS (lower(employee_no)) STORED;
CREATE INDEX person_employee_no_key_idx ON app.person (company_id, employee_no_key) WHERE employee_no_key IS NOT NULL;

-- 3) "오늘 날짜 기준 알림을 계산했는가" 표시 기록 찾기(알림함·메뉴를 열 때마다 본다).
CREATE INDEX audit_log_daily_alerts_idx ON app.audit_log (company_id, created_at DESC) WHERE action = 'DAILY_ALERTS_RUN';

-- 4) 기업 전체의 재고 이력을 최근 것부터 필요한 만큼만 읽기 위한 인덱스(정렬 순서와 같다).
CREATE INDEX asset_txn_company_time_seq_idx ON app.asset_txn (company_id, created_at DESC, seq DESC);
CREATE INDEX peripheral_txn_company_time_seq_idx ON app.peripheral_txn (company_id, created_at DESC, seq DESC);
