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
// $9 = 'ASSET'/'PERIPHERAL' 중 보여 줄 것(NULL = 둘 다), $10 limit, $11 offset
const SQL_HISTORY_TIME =
  ' AND ($6::date IS NULL OR t.created_at >= ($6::date::timestamp AT TIME ZONE $8))' +
  ' AND ($7::date IS NULL OR t.created_at < (($7::date + 1)::timestamp AT TIME ZONE $8))';
const SQL_STOCK_HISTORY =
  'SELECT x.* FROM (' +
  '  SELECT $12::text AS kind, t.id, t.seq, t.created_at, t.type, a.id AS ref_id, a.asset_tag AS ref_label, m.manufacturer, m.name AS model_name, d.name AS department_name,' +
  '    NULL::int AS qty, fp.name AS from_person, tp.name AS to_person, t.from_state, t.to_state, t.to_location AS location, t.note, u.display_name AS actor_name' +
  '    FROM app.asset_txn t' +
  '    JOIN app.asset a ON a.id = t.asset_id AND a.company_id = t.company_id' +
  '    JOIN app.item_model m ON m.id = a.model_id AND m.company_id = t.company_id' +
  '    JOIN app.department d ON d.id = a.department_id AND d.company_id = t.company_id' +
  '    LEFT JOIN app.person fp ON fp.id = t.from_holder_id AND fp.company_id = t.company_id' +
  '    LEFT JOIN app.person tp ON tp.id = t.to_holder_id AND tp.company_id = t.company_id' +
  '    LEFT JOIN app.app_user u ON u.id = t.actor_id' +
  '   WHERE t.company_id = $1 AND ($2::uuid[] IS NULL OR a.department_id = ANY($2))' +
  '     AND ($9::text IS NULL OR $9 = $12) AND ($3::text IS NULL OR t.type = $3)' +
  '     AND ($4::uuid IS NULL OR t.from_holder_id = $4 OR t.to_holder_id = $4)' +
  '     AND ($5::text IS NULL OR a.asset_tag ILIKE $5 OR m.name ILIKE $5 OR m.manufacturer ILIKE $5)' +
  SQL_HISTORY_TIME +
  '  UNION ALL' +
  '  SELECT $13::text, t.id, t.seq, t.created_at, t.type, s.id, NULL, m.manufacturer, m.name, d.name,' +
  '    t.qty, NULL, p.name, NULL, NULL, t.location_note, t.note, u.display_name' +
  '    FROM app.peripheral_txn t' +
  '    JOIN app.peripheral_stock s ON s.id = t.stock_id AND s.company_id = t.company_id' +
  '    JOIN app.item_model m ON m.id = s.model_id AND m.company_id = t.company_id' +
  '    JOIN app.department d ON d.id = s.department_id AND d.company_id = t.company_id' +
  '    LEFT JOIN app.person p ON p.id = t.person_id AND p.company_id = t.company_id' +
  '    LEFT JOIN app.app_user u ON u.id = t.actor_id' +
  '   WHERE t.company_id = $1 AND ($2::uuid[] IS NULL OR s.department_id = ANY($2))' +
  '     AND ($9::text IS NULL OR $9 = $13) AND ($3::text IS NULL OR t.type = $3)' +
  '     AND ($4::uuid IS NULL OR t.person_id = $4)' +
  '     AND ($5::text IS NULL OR m.name ILIKE $5 OR m.manufacturer ILIKE $5)' +
  SQL_HISTORY_TIME +
  ') x ORDER BY x.created_at DESC, x.kind, x.seq DESC LIMIT $10 OFFSET $11';

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
    pageSize + 1, offset, 'ASSET', 'PERIPHERAL',
  ]);
  return { page, pageSize, hasMore: rows.length > pageSize, items: rows.slice(0, pageSize) };
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
