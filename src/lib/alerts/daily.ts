// 날짜에 따라 생기는 알림: 보증 만료 임박, 자산 대여 연체, 주변기기 대여 연체.
// 기업 하나에 대해 계산한다. tenant() 트랜잭션 안에서 호출한다.
//
// 언제 계산하는가
//  - 기업마다 하루(기업 시간대 기준)에 한 번. 그날 처음 알림함을 여는 요청이 계산한다. 정기 실행기가 생기면 같은 함수를 부른다.
//  - "오늘 했는가"는 감사 로그의 DAILY_ALERTS_RUN 기록으로 판단한다(프로세스가 여러 개여도, 재시작해도 하루 한 번).
//    동시에 온 요청 중 하나만 계산하고 나머지는 기다리지 않고 건너뛴다.
// 무엇을 알리는가
//  - 아직 알리지 않은 건만, 종류마다 한 번에 최대 MAX_PER_KIND 건(받는 사람이 많으면 더 적게). 이미 알린 건은 건수 제한에 들어가기 전에 빼므로,
//    밀린 건이 많아도 날마다 다음 건들이 차례로 알려진다.
//  - 같은 건은 같은 사람에게 한 번만 만들어진다(payload.key + 고유 인덱스, 0007 마이그레이션).
import type { Db } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import { SQL_DEDUPE, SQL_IS_RECIPIENT } from './notify';
import { companyToday } from './today';

export const WARRANTY_NOTICE_DAYS = 30;
/** 한 번에 알리는 건수(종류별)의 상한. */
export const MAX_PER_KIND = 100;
/**
 * 한 번에 만드는 알림 행 수(종류별)의 목표. 알림은 (건 × 받는 사람)만큼 만들어지고 행 하나를 넣는 데 약 0.25ms 가 든다.
 * 받는 사람이 많은 기업에서는 한 번에 알리는 건수를 줄여, 이 계산을 떠맡은 요청이 오래 걸리지 않게 한다.
 */
const ROW_BUDGET_PER_KIND = 3000;
const MIN_PER_KIND = 5;

// 공통 틀: $1 기업, $2 알림 종류, $3 열쇠 앞머리, $4 오늘(기업 시간대). 안쪽 SELECT 의 열 이름이 그대로 알림 내용(payload)의 키가 된다.
// 알릴 건들을 먼저 한 번만 구해 두고(MATERIALIZED), 그것을 받을 사람과 곱한다. 이렇게 하지 않으면 받을 사람 수만큼 건 목록을 다시 구한다.
const SQL_INSERT_FOR_ITEMS_HEAD = 'WITH i AS MATERIALIZED (';
const SQL_INSERT_FOR_ITEMS_TAIL =
  ') INSERT INTO app.notification (company_id, user_id, type, payload) SELECT $1, u.id, $2, to_jsonb(i) FROM i JOIN app.app_user u ON true WHERE' +
  SQL_IS_RECIPIENT +
  SQL_DEDUPE;
// 이미 알린 건(누구에게든)은 뺀다. k = 그 건의 열쇠.
const SQL_NOT_ALERTED_HEAD = " AND NOT EXISTS (SELECT 1 FROM app.notification n WHERE n.company_id = $1 AND n.payload ? 'key' AND (n.payload ->> 'key') = ";

// $5 = 며칠 앞까지, $6 = 최대 건수
const SQL_DAILY_WARRANTY =
  SQL_INSERT_FOR_ITEMS_HEAD +
  'SELECT a.department_id, $3 || a.id || chr(58) || a.warranty_end AS key, a.id AS "assetId", a.asset_tag AS "assetTag",' +
  '  m.manufacturer || chr(32) || m.name AS model, a.warranty_end::text AS "warrantyEnd"' +
  ' FROM app.asset a JOIN app.item_model m ON m.id = a.model_id AND m.company_id = a.company_id' +
  " WHERE a.company_id = $1 AND a.state NOT IN ('RETIRED', 'VOID')" +
  '   AND a.warranty_end >= $4::date AND a.warranty_end <= $4::date + $5::int' +
  SQL_NOT_ALERTED_HEAD + '$3 || a.id || chr(58) || a.warranty_end)' +
  ' ORDER BY a.warranty_end, a.id LIMIT $6' +
  SQL_INSERT_FOR_ITEMS_TAIL;

const SQL_DAILY_ASSET_OVERDUE =
  SQL_INSERT_FOR_ITEMS_HEAD +
  'SELECT a.department_id, $3 || a.id || chr(58) || a.due_date AS key, a.id AS "assetId", a.asset_tag AS "assetTag", p.name AS holder, a.due_date::text AS "dueDate"' +
  ' FROM app.asset a LEFT JOIN app.person p ON p.id = a.holder_person_id AND p.company_id = a.company_id' +
  " WHERE a.company_id = $1 AND a.state = 'IN_USE' AND a.due_date < $4::date AND $5::int IS NOT NULL" +
  SQL_NOT_ALERTED_HEAD + '$3 || a.id || chr(58) || a.due_date)' +
  ' ORDER BY a.due_date, a.id LIMIT $6' +
  SQL_INSERT_FOR_ITEMS_TAIL;

const SQL_DAILY_LOAN_OVERDUE =
  SQL_INSERT_FOR_ITEMS_HEAD +
  'SELECT s.department_id, $3 || l.id || chr(58) || l.due_date AS key, l.id AS "loanId", m.manufacturer || chr(32) || m.name AS model,' +
  '  p.name AS holder, l.qty - l.returned_qty - l.lost_qty AS qty, l.due_date::text AS "dueDate"' +
  ' FROM app.peripheral_loan l' +
  ' JOIN app.peripheral_stock s ON s.id = l.stock_id AND s.company_id = l.company_id' +
  ' JOIN app.item_model m ON m.id = s.model_id AND m.company_id = l.company_id' +
  ' JOIN app.person p ON p.id = l.person_id AND p.company_id = l.company_id' +
  " WHERE l.company_id = $1 AND l.status = 'OPEN' AND l.due_date < $4::date AND $5::int IS NOT NULL" +
  SQL_NOT_ALERTED_HEAD + '$3 || l.id || chr(58) || l.due_date)' +
  ' ORDER BY l.due_date, l.id LIMIT $6' +
  SQL_INSERT_FOR_ITEMS_TAIL;

/** 날짜 기준 알림을 만든다(횟수 제한 없이). 새로 만든 알림 수를 돌려준다. 정기 실행기와 테스트가 직접 부른다. */
export async function runDailyAlerts(db: Db, companyId: string): Promise<number> {
  const today = await companyToday(db, companyId);
  // 받을 수 있는 사람은 많아야 그 기업의 활성 계정 수다.
  const users = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.app_user WHERE company_id = $1 AND is_active', [companyId]);
  const perKind = Math.max(MIN_PER_KIND, Math.min(MAX_PER_KIND, Math.floor(ROW_BUDGET_PER_KIND / Math.max(1, users.rows[0]?.n ?? 1))));
  const rest = [today, WARRANTY_NOTICE_DAYS, perKind];
  const a = await db.query(SQL_DAILY_WARRANTY, [companyId, 'WARRANTY_EXPIRING', 'warranty:', ...rest]);
  const b = await db.query(SQL_DAILY_ASSET_OVERDUE, [companyId, 'LOAN_OVERDUE', 'asset-overdue:', ...rest]);
  const c = await db.query(SQL_DAILY_LOAN_OVERDUE, [companyId, 'LOAN_OVERDUE', 'loan-overdue:', ...rest]);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0);
}

const DAILY_ACTION = 'DAILY_ALERTS_RUN';
// 오늘(기업 시간대) 남긴 실행 기록이 있는가. $3 은 찾아볼 기간(인덱스로 최근 것만 본다).
const SQL_DAILY_DONE_TODAY =
  'SELECT 1 FROM app.audit_log a JOIN app.company c ON c.id = a.company_id' +
  ' WHERE a.company_id = $1 AND a.action = $2 AND (a.created_at AT TIME ZONE c.timezone)::date = (now() AT TIME ZONE c.timezone)::date' +
  ' AND a.created_at > now() - $3::interval LIMIT 1';

/** 오늘(기업 시간대) 아직 하지 않았으면 계산한다. 했거나 다른 요청이 하는 중이면 아무것도 하지 않는다. */
export async function runDailyAlertsOncePerDay(db: Db, companyId: string): Promise<boolean> {
  const lock = await db.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(727006, hashtext($1)) AS ok', [companyId]);
  if (!lock.rows[0]?.ok) return false;
  const done = await db.query(SQL_DAILY_DONE_TODAY, [companyId, DAILY_ACTION, '2 days']);
  if (done.rowCount) return false;
  const created = await runDailyAlerts(db, companyId);
  await writeAudit(db, { companyId, actorId: null, action: DAILY_ACTION, resource: 'alert.inbox', after: { notifications: created } });
  return true;
}
