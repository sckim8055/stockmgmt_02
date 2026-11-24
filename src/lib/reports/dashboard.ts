// 대시보드 집계. tenant() 트랜잭션 안에서 호출한다.
//
//  - 모든 수치는 요청자의 부서 범위 안에서만 센다.
//  - 구역마다 그 자료의 조회 권한이 있어야 채운다(대시보드 권한만으로 다른 화면의 자료를 보지 못한다). 권한이 없는 구역은 null.
//  - 금액 등 제한 필드는 집계하지 않는다.
import { WARRANTY_NOTICE_DAYS } from '@/lib/alerts/daily';
import { companyToday } from '@/lib/alerts/today';
import type { Db } from '@/lib/db/context';
import { actorPermissions, permKey } from '@/lib/authz/grants';
import type { DataAccess } from '@/lib/authz/scope';
import type { Actor } from '@/lib/http/route';

// $1 기업, $2 부서 범위(NULL = 전체)
const SQL_DASH_ASSET_STATES =
  'SELECT a.state, a.substate, count(*)::int AS n FROM app.asset a' +
  ' WHERE a.company_id = $1 AND ($2::uuid[] IS NULL OR a.department_id = ANY($2)) AND a.state <> $3 GROUP BY a.state, a.substate ORDER BY a.state, a.substate';
const SQL_DASH_ASSET_CATEGORIES =
  'SELECT c.id, c.name, count(*) FILTER (WHERE a.state = $3 AND a.substate = $4)::int AS available, count(*) FILTER (WHERE a.state = $5)::int AS in_use, count(*)::int AS total' +
  ' FROM app.asset a JOIN app.item_model m ON m.id = a.model_id AND m.company_id = a.company_id JOIN app.category c ON c.id = m.category_id AND c.company_id = a.company_id' +
  ' WHERE a.company_id = $1 AND ($2::uuid[] IS NULL OR a.department_id = ANY($2)) AND a.state <> ALL($6::text[])' +
  ' GROUP BY c.id, c.name ORDER BY count(*) DESC, lower(c.name) LIMIT 12';
// $3 오늘(기업 시간대), $4 보증 만료를 미리 알리는 날 수
const SQL_DASH_ASSET_DATES =
  'SELECT count(*) FILTER (WHERE a.state = $5 AND a.due_date < $3::date)::int AS overdue,' +
  ' count(*) FILTER (WHERE a.state <> ALL($6::text[]) AND a.warranty_end >= $3::date AND a.warranty_end <= $3::date + $4::int)::int AS warranty_soon' +
  ' FROM app.asset a WHERE a.company_id = $1 AND ($2::uuid[] IS NULL OR a.department_id = ANY($2))';
const SQL_DASH_PERIPHERALS =
  'SELECT coalesce(sum(s.on_hand_qty), 0)::int AS on_hand, coalesce(sum(s.on_loan_qty), 0)::int AS on_loan, count(*)::int AS stock_rows' +
  ' FROM app.peripheral_stock s WHERE s.company_id = $1 AND ($2::uuid[] IS NULL OR s.department_id = ANY($2))';
const SQL_DASH_LOANS =
  'SELECT count(*)::int AS open, count(*) FILTER (WHERE l.due_date < $3::date)::int AS overdue' +
  ' FROM app.peripheral_loan l JOIN app.peripheral_stock s ON s.id = l.stock_id AND s.company_id = l.company_id' +
  ' WHERE l.company_id = $1 AND l.status = $4 AND ($2::uuid[] IS NULL OR s.department_id = ANY($2))';
// 한계 수량은 그 화면과 같은 규칙으로 보인다: 범위가 제한된 사용자는 자기 부서 것만(기업 전체 것은 보이지 않는다).
const SQL_DASH_THRESHOLDS =
  'SELECT count(*) FILTER (WHERE t.is_active)::int AS active, count(*) FILTER (WHERE t.is_active AND t.state = $3)::int AS low' +
  ' FROM app.stock_threshold t WHERE t.company_id = $1 AND ($2::uuid[] IS NULL OR t.department_id = ANY($2))';

export async function loadDashboard(db: Db, actor: Actor, access: DataAccess) {
  const perms = await actorPermissions(db, actor);
  const can = (resource: string) => perms === null || perms.has(permKey(resource, 'read'));
  const base = [actor.companyId, access.scope];
  const today = await companyToday(db, actor.companyId);

  let assets = null;
  if (can('asset.item')) {
    const states = await db.query<{ state: string; substate: string | null; n: number }>(SQL_DASH_ASSET_STATES, [...base, 'VOID']);
    const categories = await db.query(SQL_DASH_ASSET_CATEGORIES, [...base, 'IN_STOCK', 'AVAILABLE', 'IN_USE', ['VOID', 'RETIRED']]);
    const dates = await db.query<{ overdue: number; warranty_soon: number }>(SQL_DASH_ASSET_DATES, [...base, today, WARRANTY_NOTICE_DAYS, 'IN_USE', ['VOID', 'RETIRED']]);
    assets = {
      total: states.rows.reduce((sum, r) => sum + r.n, 0),
      byState: states.rows,
      byCategory: categories.rows,
      overdue: dates.rows[0]?.overdue ?? 0,
      warrantySoon: dates.rows[0]?.warranty_soon ?? 0,
    };
  }

  let peripherals = null;
  if (can('peripheral.stock')) {
    const r = await db.query<{ on_hand: number; on_loan: number; stock_rows: number }>(SQL_DASH_PERIPHERALS, base);
    peripherals = { onHand: r.rows[0]?.on_hand ?? 0, onLoan: r.rows[0]?.on_loan ?? 0, stockRows: r.rows[0]?.stock_rows ?? 0 };
  }

  let loans = null;
  if (can('peripheral.loan')) {
    const r = await db.query<{ open: number; overdue: number }>(SQL_DASH_LOANS, [...base, today, 'OPEN']);
    loans = { open: r.rows[0]?.open ?? 0, overdue: r.rows[0]?.overdue ?? 0 };
  }

  let thresholds = null;
  if (can('threshold')) {
    const r = await db.query<{ active: number; low: number }>(SQL_DASH_THRESHOLDS, [...base, 'LOW']);
    thresholds = { active: r.rows[0]?.active ?? 0, low: r.rows[0]?.low ?? 0 };
  }

  return { today, scoped: !access.unrestricted, assets, peripherals, loans, thresholds };
}
