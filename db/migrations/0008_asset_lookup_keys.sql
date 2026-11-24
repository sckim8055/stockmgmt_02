-- 자산 태그·시리얼 번호의 중복 검사를 빠르게 한다.
--
-- 지금까지는 `lower(asset_tag) = lower($2)` 로 찾았는데, 앱 역할에는 행 수준 보안(RLS)이 걸려 있어
-- PostgreSQL 이 lower() 가 든 조건을 인덱스 조건으로 쓰지 못한다(lower 는 "누설 방지" 함수가 아니라서, 보안 조건보다 먼저 평가할 수 없다).
-- 그래서 검사 한 번이 그 기업의 자산 전체를 훑었고, 자산 2만 대인 기업에서 자산 한 건 등록에 약 27ms 가 더 걸렸다
-- (2,000행 엑셀 업로드가 10초 → 38초).
-- 소문자로 바꾼 값을 저장된 열로 두면 평범한 `=` 비교가 되어 인덱스를 쓸 수 있다.
-- 고유성은 기존의 고유 인덱스(asset_company_tag_key, asset_model_serial_key)가 그대로 지킨다.

ALTER TABLE app.asset
  ADD COLUMN asset_tag_key text GENERATED ALWAYS AS (lower(asset_tag)) STORED,
  ADD COLUMN serial_key text GENERATED ALWAYS AS (lower(serial_number)) STORED;

CREATE INDEX asset_tag_key_idx ON app.asset (company_id, asset_tag_key);
CREATE INDEX asset_serial_key_idx ON app.asset (company_id, model_id, serial_key) WHERE serial_key IS NOT NULL;
