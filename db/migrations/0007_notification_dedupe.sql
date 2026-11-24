-- 같은 알림을 같은 사람에게 두 번 만들지 않기 위한 열쇠(예: "warranty:<자산>:<만료일>").
-- 날짜에 따라 생기는 알림(보증 만료 임박, 대여 연체)은 알림함을 열 때마다 다시 계산하는데,
-- 이 인덱스 덕분에 이미 알린 건은 다시 만들어지지 않는다.
-- 열쇠가 없는 알림(재고 부족처럼 일어날 때마다 알리는 것)은 제한을 받지 않는다.
CREATE UNIQUE INDEX notification_dedupe_key ON app.notification (user_id, (payload ->> 'key')) WHERE payload ? 'key';
