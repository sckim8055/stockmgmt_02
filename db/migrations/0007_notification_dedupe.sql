-- 같은 알림을 같은 사람에게 두 번 만들지 않기 위한 열쇠(예: "warranty:<자산>:<만료일>").
-- 날짜에 따라 생기는 알림(보증 만료 임박, 대여 연체)은 알림함을 열 때마다 다시 계산하는데,
-- 이 인덱스 덕분에 이미 알린 건은 다시 만들어지지 않는다.
-- 열쇠가 없는 알림(재고 부족처럼 일어날 때마다 알리는 것)은 제한을 받지 않는다.
CREATE UNIQUE INDEX notification_dedupe_key ON app.notification (user_id, (payload ->> 'key')) WHERE payload ? 'key';

-- "이 건은 이미 알렸는가"를 기업 단위로 빨리 확인하기 위한 인덱스(날짜 기준 알림이 이미 알린 건을 건너뛸 때 쓴다).
CREATE INDEX notification_company_key_idx ON app.notification (company_id, (payload ->> 'key')) WHERE payload ? 'key';

-- 한계 수량 판정은 "재고·사용 가능" 자산을 모델별로 센다. 자산이 많은 기업에서 재고가 바뀔 때마다 전체를 훑지 않도록 한다.
CREATE INDEX asset_available_idx ON app.asset (company_id, model_id, department_id) WHERE state = 'IN_STOCK' AND substate = 'AVAILABLE';
