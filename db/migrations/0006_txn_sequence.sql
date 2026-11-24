-- 이력의 순서를 확정하는 일련번호.
-- created_at 의 기본값 now() 는 트랜잭션 시작 시각이라, 한 트랜잭션에서 남긴 여러 이력(예: 엑셀 업로드의 등록 + 배정,
-- 관리 부서 변경 + 정보 수정)은 시각이 같다. 지금까지는 그 안에서의 순서가 정해지지 않았다.
-- 조회는 (created_at, seq) 순으로 한다.
-- 테이블 권한(SELECT, INSERT)은 0002 에서 테이블 단위로 주었으므로 새 컬럼에도 적용된다.

ALTER TABLE app.asset_txn ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE app.peripheral_txn ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
