// 날짜에 따라 생기는 알림: 보증 만료 임박, 자산 대여 연체, 주변기기 대여 연체.
// 기업 하나에 대해 계산한다. tenant() 트랜잭션 안에서 호출한다.
//
// 지금은 누군가 알림함의 첫 쪽을 열 때 계산한다. 정기 실행기가 생기면 같은 함수를 부른다.
// 몇 번을 불러도 같은 건은 같은 사람에게 한 번만 만들어진다(payload.key + 고유 인덱스, 0007 마이그레이션).
// 대상마다 쿼리를 보내지 않고 종류별로 쿼리 한 번에 (대상 × 받을 사람)을 넣는다.
import type { Db } from '@/lib/db/context';
import { SQL_DEDUPE, SQL_IS_RECIPIENT } from './notify';

export const WARRANTY_NOTICE_DAYS = 30;
const MAX_PER_KIND = 500;

// 공통 틀: $1 기업, $2 알림 종류, $3 열쇠 앞머리. 안쪽 SELECT 의 열 이름이 그대로 알림 내용(payload)의 키가 된다.
const SQL_INSERT_FOR_ITEMS_HEAD = 'INSERT INTO app.notification (company_id, user_id, type, payload) SELECT $1, u.id, $2, to_jsonb(i) FROM app.app_user u JOIN (';
const SQL_INSERT_FOR_ITEMS_TAIL = ') i ON true WHERE' + SQL_IS_RECIPIENT + SQL_DEDUPE;

// $4 = 며칠 앞까지, $5 = 최대 건수
const SQL_DAILY_WARRANTY =
  SQL_INSERT_FOR_ITEMS_HEAD +
  'SELECT a.department_id, $3 || a.id || chr(58) || a.warranty_end AS key, a.id AS "assetId", a.asset_tag AS "assetTag",' +
  '  m.manufacturer || chr(32) || m.name AS model, a.warranty_end::text AS "warrantyEnd"' +
  ' FROM app.asset a JOIN app.item_model m ON m.id = a.model_id AND m.company_id = a.company_id' +
  " WHERE a.company_id = $1 AND a.state NOT IN ('RETIRED', 'VOID')" +
  '   AND a.warranty_end >= current_date AND a.warranty_end <= current_date + $4::int' +
  ' ORDER BY a.warranty_end, a.id LIMIT $5' +
  SQL_INSERT_FOR_ITEMS_TAIL;

// $4 = 최대 건수
const SQL_DAILY_ASSET_OVERDUE =
  SQL_INSERT_FOR_ITEMS_HEAD +
  'SELECT a.department_id, $3 || a.id || chr(58) || a.due_date AS key, a.id AS "assetId", a.asset_tag AS "assetTag", p.name AS holder, a.due_date::text AS "dueDate"' +
  ' FROM app.asset a LEFT JOIN app.person p ON p.id = a.holder_person_id AND p.company_id = a.company_id' +
  " WHERE a.company_id = $1 AND a.state = 'IN_USE' AND a.due_date < current_date ORDER BY a.due_date, a.id LIMIT $4" +
  SQL_INSERT_FOR_ITEMS_TAIL;

const SQL_DAILY_LOAN_OVERDUE =
  SQL_INSERT_FOR_ITEMS_HEAD +
  'SELECT s.department_id, $3 || l.id || chr(58) || l.due_date AS key, l.id AS "loanId", m.manufacturer || chr(32) || m.name AS model,' +
  '  p.name AS holder, l.qty - l.returned_qty - l.lost_qty AS qty, l.due_date::text AS "dueDate"' +
  ' FROM app.peripheral_loan l' +
  ' JOIN app.peripheral_stock s ON s.id = l.stock_id AND s.company_id = l.company_id' +
  ' JOIN app.item_model m ON m.id = s.model_id AND m.company_id = l.company_id' +
  ' JOIN app.person p ON p.id = l.person_id AND p.company_id = l.company_id' +
  " WHERE l.company_id = $1 AND l.status = 'OPEN' AND l.due_date < current_date ORDER BY l.due_date, l.id LIMIT $4" +
  SQL_INSERT_FOR_ITEMS_TAIL;

/** 날짜 기준 알림을 만든다. 새로 만든 알림 수를 돌려준다. */
export async function runDailyAlerts(db: Db, companyId: string): Promise<number> {
  const a = await db.query(SQL_DAILY_WARRANTY, [companyId, 'WARRANTY_EXPIRING', 'warranty:', WARRANTY_NOTICE_DAYS, MAX_PER_KIND]);
  const b = await db.query(SQL_DAILY_ASSET_OVERDUE, [companyId, 'LOAN_OVERDUE', 'asset-overdue:', MAX_PER_KIND]);
  const c = await db.query(SQL_DAILY_LOAN_OVERDUE, [companyId, 'LOAN_OVERDUE', 'loan-overdue:', MAX_PER_KIND]);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0);
}
