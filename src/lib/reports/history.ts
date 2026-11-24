// 이력 조회: 재고 이력(자산 + 주변기기)과 감사 로그. tenant() 트랜잭션 안에서 호출한다.
//
//  - 재고 이력은 부서 범위를 따른다(자산은 지금의 관리 부서, 주변기기는 재고 행의 부서).
//  - 감사 로그는 기업 전체의 관리 기록이라 부서 범위 제한이 없는 사용자만 본다.
//  - 날짜 조건은 기업의 시간대로 해석한다.
//  - 전체 건수는 세지 않는다(이력은 계속 쌓인다). 한 건 더 읽어 "다음 쪽이 있는지"만 알려 준다.
import type { Db } from '@/lib/db/context';
import type { DataAccess } from '@/lib/authz/scope';
import { forbidden } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

async function companyTimezone(db: Db, companyId: string): Promise<string> {
  const { rows } = await db.query<{ timezone: string }>('SELECT timezone FROM app.company WHERE id = $1', [companyId]);
  return rows[0]?.timezone ?? 'UTC';
}

function paging(q: { page?: number; pageSize?: number }) {
  const pageSize = Math.min(Math.max(q.pageSize ?? 50, 1), 200);
  const page = Math.max(q.page ?? 1, 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// 공통 인자: $1 기업, $2 부서 범위, $3 종류(type), $4 직원, $5 검색, $6 시작일, $7 끝일, $8 시간대
// $9 = 'ASSET'/'PERIPHERAL' 중 보여 줄 것(NULL = 둘 다), $10 limit, $11 offset, $12 'ASSET', $13 'PERIPHERAL',
// $14 = 한쪽에서 고를 최대 행 수(offset + limit), $15 = 한쪽에서 살펴볼 최대 행 수(HISTORY_SCAN_WINDOW)
//
// 읽는 방식(안쪽부터)
//  w: 이력 테이블을 (기업, 시각 내림차순) 인덱스 순서로, 기간 조건 안에서 최근 $15 행까지만 읽는다. 여기까지가 읽는 양의 상한이다.
//  k: 그 안에서 조건(종류·직원·부서 범위·검색)에 맞는 행을 $14 행까지 고른다. 자산·재고 쪽 조건은 EXISTS 로 행마다 확인한다.
//  바깥: 한 쪽으로 줄인 뒤에만 이름(모델·부서·사람·처리자)을 붙인다. 사람·부서·처리자 이름은 행마다 기본 키로 하나씩 찾는다(스칼라 부질의).
//        조인으로 쓰면 PostgreSQL 이 행 수를 잘못 어림해 사람 테이블을 행마다 통째로 읽는 계획을 고를 수 있다.
// 그래서 조건이 드물게 맞아도(범위가 작은 부서, 맞는 것이 없는 검색어) 읽는 양이 이력 전체로 늘지 않는다.
// 대신 조건은 "기간 안의 최근 $15 건" 안에서만 찾는다. 더 이전 것은 기간을 지정해 찾는다(화면이 그렇게 안내한다).
export const HISTORY_SCAN_WINDOW = 20000;
const SQL_HISTORY_TIME =
  ' AND ($6::date IS NULL OR t.created_at >= ($6::date::timestamp AT TIME ZONE $8))' +
  ' AND ($7::date IS NULL OR t.created_at < (($7::date + 1)::timestamp AT TIME ZONE $8))';
// 안쪽(y): 두 이력에서 고른 행을 합쳐 정렬하고 한 쪽만 남긴다. 이름은 붙이지 않는다.
const SQL_STOCK_HISTORY_PAGE =
  'SELECT x.* FROM (' +
  '  SELECT $12::text AS kind, k.id, k.seq, k.created_at, k.type, k.company_id, k.asset_id AS ref_id, k.from_holder_id AS from_person_id, k.to_holder_id AS to_person_id,' +
  '    NULL::int AS qty, k.from_state, k.to_state, k.to_location AS location, k.note, k.actor_id' +
  '    FROM (' +
  '      SELECT w.* FROM (' +
  '        SELECT t.id, t.seq, t.created_at, t.type, t.asset_id, t.from_holder_id, t.to_holder_id, t.from_state, t.to_state, t.to_location, t.note, t.actor_id, t.company_id' +
  '          FROM app.asset_txn t' +
  '         WHERE t.company_id = $1 AND ($9::text IS NULL OR $9 = $12)' +
  SQL_HISTORY_TIME +
  '         ORDER BY t.created_at DESC, t.seq DESC LIMIT $15' +
  '      ) w' +
  '       WHERE ($3::text IS NULL OR w.type = $3)' +
  '         AND ($4::uuid IS NULL OR w.from_holder_id = $4 OR w.to_holder_id = $4)' +
  '         AND (($2::uuid[] IS NULL AND $5::text IS NULL) OR EXISTS (' +
  '               SELECT 1 FROM app.asset a JOIN app.item_model m ON m.id = a.model_id AND m.company_id = a.company_id' +
  '                WHERE a.id = w.asset_id AND a.company_id = w.company_id' +
  '                  AND ($2::uuid[] IS NULL OR a.department_id = ANY($2))' +
  '                  AND ($5::text IS NULL OR a.asset_tag ILIKE $5 OR m.name ILIKE $5 OR m.manufacturer ILIKE $5)))' +
  '       ORDER BY w.created_at DESC, w.seq DESC LIMIT $14' +
  '    ) k' +
  '  UNION ALL' +
  '  SELECT $13::text, k.id, k.seq, k.created_at, k.type, k.company_id, k.stock_id, NULL::uuid, k.person_id,' +
  '    k.qty, NULL, NULL, k.location_note, k.note, k.actor_id' +
  '    FROM (' +
  '      SELECT w.* FROM (' +
  '        SELECT t.id, t.seq, t.created_at, t.type, t.stock_id, t.qty, t.person_id, t.location_note, t.note, t.actor_id, t.company_id' +
  '          FROM app.peripheral_txn t' +
  '         WHERE t.company_id = $1 AND ($9::text IS NULL OR $9 = $13)' +
  SQL_HISTORY_TIME +
  '         ORDER BY t.created_at DESC, t.seq DESC LIMIT $15' +
  '      ) w' +
  '       WHERE ($3::text IS NULL OR w.type = $3)' +
  '         AND ($4::uuid IS NULL OR w.person_id = $4)' +
  '         AND (($2::uuid[] IS NULL AND $5::text IS NULL) OR EXISTS (' +
  '               SELECT 1 FROM app.peripheral_stock s JOIN app.item_model m ON m.id = s.model_id AND m.company_id = s.company_id' +
  '                WHERE s.id = w.stock_id AND s.company_id = w.company_id' +
  '                  AND ($2::uuid[] IS NULL OR s.department_id = ANY($2))' +
  '                  AND ($5::text IS NULL OR m.name ILIKE $5 OR m.manufacturer ILIKE $5)))' +
  '       ORDER BY w.created_at DESC, w.seq DESC LIMIT $14' +
  '    ) k' +
  ') x ORDER BY x.created_at DESC, x.kind, x.seq DESC LIMIT $10 OFFSET $11';

// 바깥: 남은 한 쪽(최대 201행)에만 이름을 붙인다. 자산이면 자산·모델·부서, 주변기기면 재고·모델·부서를 기본 키로 찾는다.
const SQL_STOCK_HISTORY =
  'SELECT y.kind, y.id, y.seq, y.created_at, y.type, y.ref_id, a.asset_tag AS ref_label,' +
  '  coalesce(am.manufacturer, sm.manufacturer) AS manufacturer, coalesce(am.name, sm.name) AS model_name,' +
  '  (SELECT d.name FROM app.department d WHERE d.id = coalesce(a.department_id, s.department_id) AND d.company_id = y.company_id) AS department_name,' +
  '  y.qty,' +
  '  (SELECT p.name FROM app.person p WHERE p.id = y.from_person_id AND p.company_id = y.company_id) AS from_person,' +
  '  (SELECT p.name FROM app.person p WHERE p.id = y.to_person_id AND p.company_id = y.company_id) AS to_person,' +
  '  y.from_state, y.to_state, y.location, y.note,' +
  '  (SELECT u.display_name FROM app.app_user u WHERE u.id = y.actor_id) AS actor_name' +
  ' FROM (' + SQL_STOCK_HISTORY_PAGE + ') y' +
  ' LEFT JOIN app.asset a ON y.kind = $12 AND a.id = y.ref_id AND a.company_id = y.company_id' +
  ' LEFT JOIN app.item_model am ON am.id = a.model_id AND am.company_id = y.company_id' +
  ' LEFT JOIN app.peripheral_stock s ON y.kind = $13 AND s.id = y.ref_id AND s.company_id = y.company_id' +
  ' LEFT JOIN app.item_model sm ON sm.id = s.model_id AND sm.company_id = y.company_id' +
  ' ORDER BY y.created_at DESC, y.kind, y.seq DESC';

export interface StockHistoryQuery {
  kind?: 'ASSET' | 'PERIPHERAL';
  type?: string;
  personId?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function listStockHistory(db: Db, actor: Actor, access: DataAccess, query: StockHistoryQuery) {
  const { page, pageSize, offset } = paging(query);
  const q = query.q?.trim();
  const { rows } = await db.query(SQL_STOCK_HISTORY, [
    actor.companyId, access.scope, query.type ?? null, query.personId ?? null, q ? likePattern(q) : null,
    query.from ?? null, query.to ?? null, await companyTimezone(db, actor.companyId), query.kind ?? null,
    pageSize + 1, offset, 'ASSET', 'PERIPHERAL', offset + pageSize + 1, HISTORY_SCAN_WINDOW,
  ]);
  // filtered: 조건(종류·직원·검색·부서 범위)이 걸려 있어 "최근 scanWindow 건 안에서만" 찾은 결과인가. 화면이 안내 문구를 보여 준다.
  const filtered = Boolean(query.type || query.personId || q || access.scope);
  return { page, pageSize, hasMore: rows.length > pageSize, items: rows.slice(0, pageSize), filtered, scanWindow: HISTORY_SCAN_WINDOW };
}

// $1 기업, $2 행위(앞머리 일치), $3 리소스, $4 행위자, $5 대상 ID, $6 시작일, $7 끝일, $8 시간대, $9 limit, $10 offset
const SQL_AUDIT_LIST =
  'SELECT t.id, t.created_at, t.action, t.resource, t.target_id, t.before, t.after, t.ip, t.actor_id, u.display_name AS actor_name, u.login_id AS actor_login' +
  ' FROM app.audit_log t LEFT JOIN app.app_user u ON u.id = t.actor_id AND u.company_id = t.company_id' +
  ' WHERE t.company_id = $1' +
  '   AND ($2::text IS NULL OR t.action LIKE $2) AND ($3::text IS NULL OR t.resource = $3)' +
  '   AND ($4::uuid IS NULL OR t.actor_id = $4) AND ($5::text IS NULL OR t.target_id = $5)' +
  SQL_HISTORY_TIME +
  ' ORDER BY t.created_at DESC, t.id DESC LIMIT $9 OFFSET $10';

export interface AuditQuery {
  action?: string;
  resource?: string;
  actorId?: string;
  targetId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function listAudit(db: Db, actor: Actor, access: DataAccess, query: AuditQuery) {
  if (!access.unrestricted) throw forbidden('감사 로그는 부서 범위 제한이 없는 사용자만 볼 수 있습니다.');
  const { page, pageSize, offset } = paging(query);
  const action = query.action?.trim();
  const { rows } = await db.query(SQL_AUDIT_LIST, [
    actor.companyId, action ? `${action.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null, query.resource ?? null, query.actorId ?? null, query.targetId ?? null,
    query.from ?? null, query.to ?? null, await companyTimezone(db, actor.companyId), pageSize + 1, offset,
  ]);
  return { page, pageSize, hasMore: rows.length > pageSize, items: rows.slice(0, pageSize) };
}
