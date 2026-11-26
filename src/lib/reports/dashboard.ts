// 대시보드 집계. tenant() 트랜잭션 안에서 호출한다.
//
//  - 모든 수치는 요청자의 부서 범위 안에서만 센다(자산은 지금의 관리 부서, 주변기기는 재고 행의 부서).
//  - 구역마다 그 자료의 조회 권한이 있어야 채운다(대시보드 권한만으로 다른 화면의 자료를 보지 못한다). 권한이 없는 구역은 null.
//  - 금액·공급업체는 집계하지 않는다. 제한된 사용자 지정 필드는 읽을 권한이 있을 때만 기준(dimension)·조건으로 쓸 수 있다.
//  - 자산 패널의 조건은 자산 목록과 같은 SQL(SQL_ASSET_FILTERS)로 건다. 그래서 막대·조각을 눌러 "목록 보기"로 가면
//    목록의 전체 건수가 대시보드의 수와 같다(tests/dashboard.test.ts 가 패널·구간마다 확인한다).
//  - 쿼리마다 결과 행 수에 상한이 있다(묶음 12개 + 기타, 연도 400행, 목록 10행 …). 이력 추이는 고른 기간 안에서,
//    한쪽(자산·주변기기)마다 최근 TREND_SCAN_CAP 건까지만 읽는다(넘으면 truncated).
import { WARRANTY_NOTICE_DAYS } from '@/lib/alerts/daily';
import { SQL_THRESHOLD_JOINS, SQL_THRESHOLD_QTY, SQL_THRESHOLD_TARGET } from '@/lib/alerts/thresholds';
import { prepareAssetFilter, resolveCustomKey, SQL_ASSET_FILTERS, SQL_ASSET_FROM, SQL_ASSET_VISIBLE, type AssetExactFilter } from '@/lib/assets/assets';
import type { AssetState } from '@/lib/assets/transitions';
import type { Db } from '@/lib/db/context';
import { actorPermissions, permKey } from '@/lib/authz/grants';
import type { DataAccess } from '@/lib/authz/scope';
import { badRequest } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';

/** "묶음별" 막대의 기본 기준. 사용자 지정 필드는 'cf.<키>'. */
export const DASH_DIMENSIONS = ['category', 'manufacturer', 'model', 'department', 'location', 'holder'] as const;
export type DashDimension = (typeof DASH_DIMENSIONS)[number];
export const TREND_MONTHS = [3, 6, 12] as const;
/** 묶음별 막대에 따로 보여 주는 묶음 수. 나머지는 "기타" 하나로 합친다. */
export const BREAKDOWN_TOP = 12;
/** 구매 연도 막대: 올해부터 거슬러 따로 보여 주는 해 수. 더 이전은 한 막대로 합친다. */
export const AGE_YEARS = 10;
/** 주의 목록의 행 수(종류마다) */
export const ATTENTION_LIMIT = 10;
/** 부족 목록의 행 수 */
export const LOW_STOCK_LIMIT = 10;
/** 주변기기 카테고리 막대 수 */
export const PERIPHERAL_CATEGORY_LIMIT = 12;
/** 이력 추이: 한쪽마다 읽는 최대 행 수(기간 안의 최근 것부터). 넘으면 truncated=true 로 알린다. */
export const TREND_SCAN_CAP = 100000;
/** 보증 만료 구간의 경계(오늘부터 날 수). 첫 경계가 "보증 만료 임박" 창(WARRANTY_NOTICE_DAYS)이다. */
export const WARRANTY_EDGES = [WARRANTY_NOTICE_DAYS, 90, 180, 365] as const;

// ─────────────────────────── SQL ───────────────────────────

// 자산 패널 공통: 목록과 같은 FROM·범위·조건. $1~$39 는 prepareAssetFilter().args() 의 순서다.
const SQL_DASH_ASSETS = SQL_ASSET_FROM + 'WHERE' + SQL_ASSET_VISIBLE + SQL_ASSET_FILTERS;

// 상태 도넛: 상태 조건을 비우고 부른다(자산 목록의 상태 칩과 같다). 결과는 (상태, 세부 상태) 조합 수만큼.
const SQL_DASH_STATES = 'SELECT a.state, a.substate, count(*)::int AS n' + SQL_DASH_ASSETS + ' GROUP BY a.state, a.substate ORDER BY a.state, a.substate';

// 핵심 수치와 보증 구간. 한 행. $40 오늘, $41 임박 창(날), $42 IN_USE, $43 RETIRED, $44~$46 구간 경계(날).
// 보증 구간은 퇴역 자산을 뺀다(보증 만료 알림과 같은 기준). 목록으로 갈 때는 active=true 를 붙인다.
const SQL_DASH_FACTS =
  'SELECT count(*)::int AS total,' +
  ' count(*) FILTER (WHERE a.state = $42 AND a.due_date < $40::date)::int AS overdue,' +
  ' count(*) FILTER (WHERE a.state <> $43 AND a.warranty_end < $40::date)::int AS w_expired,' +
  ' count(*) FILTER (WHERE a.state <> $43 AND a.warranty_end >= $40::date AND a.warranty_end <= $40::date + $41::int)::int AS w_soon,' +
  ' count(*) FILTER (WHERE a.state <> $43 AND a.warranty_end > $40::date + $41::int AND a.warranty_end <= $40::date + $44::int)::int AS w_d90,' +
  ' count(*) FILTER (WHERE a.state <> $43 AND a.warranty_end > $40::date + $44::int AND a.warranty_end <= $40::date + $45::int)::int AS w_d180,' +
  ' count(*) FILTER (WHERE a.state <> $43 AND a.warranty_end > $40::date + $45::int AND a.warranty_end <= $40::date + $46::int)::int AS w_d365,' +
  ' count(*) FILTER (WHERE a.state <> $43 AND a.warranty_end > $40::date + $46::int)::int AS w_later,' +
  ' count(*) FILTER (WHERE a.state <> $43 AND a.warranty_end IS NULL)::int AS w_none' +
  SQL_DASH_ASSETS;

// 묶음별 막대. 기준마다 상수 하나(입력값이 SQL 에 들어가지 않는다). $40 = 따로 보여 줄 묶음 수, 사용자 지정 필드는 $41 = 키.
// y: (묶음, 상태, 세부 상태)별 건수 → 묶음 합계(gt)로 순위(rk)를 매겨 위 $40 개는 그대로, 나머지는 상태별로 합쳐 rk = 0 한 묶음으로.
// "값 없음" 묶음의 키는 NULL 이다(목록의 blank= 조건과 같은 식: length(btrim(x)) > 0 이 아니면 없음).
const SQL_DASH_BY_HEAD = 'WITH y AS (SELECT ';
const SQL_DASH_BY_TAIL =
  ' a.state, a.substate, count(*)::int AS n' + SQL_DASH_ASSETS + ' GROUP BY 1, 2, 3, a.state, a.substate),' +
  ' z AS (SELECT y.*, sum(y.n) OVER (PARTITION BY y.k)::int AS gt FROM y),' +
  ' r AS (SELECT z.*, dense_rank() OVER (ORDER BY z.gt DESC, lower(z.l1) NULLS LAST, z.k NULLS LAST) AS rk FROM z)' +
  ' SELECT r.rk::int AS rk, r.k, r.l1, r.l2, r.state, r.substate, r.n, 1 AS groups FROM r WHERE r.rk <= $40' +
  ' UNION ALL' +
  ' SELECT 0, NULL, NULL, NULL, r.state, r.substate, sum(r.n)::int, count(DISTINCT r.rk)::int FROM r WHERE r.rk > $40 GROUP BY r.state, r.substate' +
  ' ORDER BY 1, 5, 6';
const SQL_DASH_BY: Record<string, string> = {
  category: SQL_DASH_BY_HEAD + 'c.id::text AS k, c.name AS l1, NULL::text AS l2,' + SQL_DASH_BY_TAIL,
  manufacturer: SQL_DASH_BY_HEAD + 'm.manufacturer AS k, m.manufacturer AS l1, NULL::text AS l2,' + SQL_DASH_BY_TAIL,
  model: SQL_DASH_BY_HEAD + 'a.model_id::text AS k, m.name AS l1, m.manufacturer AS l2,' + SQL_DASH_BY_TAIL,
  department: SQL_DASH_BY_HEAD + 'a.department_id::text AS k, d.name AS l1, NULL::text AS l2,' + SQL_DASH_BY_TAIL,
  location: SQL_DASH_BY_HEAD + 'CASE WHEN length(btrim(a.location)) > 0 THEN a.location END AS k, CASE WHEN length(btrim(a.location)) > 0 THEN a.location END AS l1, NULL::text AS l2,' + SQL_DASH_BY_TAIL,
  holder: SQL_DASH_BY_HEAD + '(a.holder_person_id IS NOT NULL)::text AS k, (a.holder_person_id IS NOT NULL)::text AS l1, NULL::text AS l2,' + SQL_DASH_BY_TAIL,
  custom: SQL_DASH_BY_HEAD +
    'CASE WHEN length(btrim(a.custom ->> $41::text)) > 0 THEN a.custom ->> $41::text END AS k, CASE WHEN length(btrim(a.custom ->> $41::text)) > 0 THEN a.custom ->> $41::text END AS l1, NULL::text AS l2,' +
    SQL_DASH_BY_TAIL,
};

// 구매 연도. 해마다 한 행(NULL = 구매일 없음). 날짜의 연도는 1900~2200 으로 검증해 받으므로 400행이면 충분하다.
const SQL_DASH_AGE = 'SELECT extract(year FROM a.purchase_date)::int AS y, count(*)::int AS n' + SQL_DASH_ASSETS + ' GROUP BY 1 ORDER BY 1 DESC NULLS LAST LIMIT 400';

// 주의가 필요한 자산(종류마다 $41 행). $40 오늘, $42 IN_USE, $43 RETIRED, $44 임박 창, $45 MISSING, $46~$48 종류 이름.
const SQL_DASH_ATTENTION_COLUMNS =
  ' a.id, a.asset_tag, m.manufacturer, m.name AS model_name, p.name AS holder_name, d.name AS department_name,' +
  ' a.due_date::text AS due_date, a.warranty_end::text AS warranty_end, a.updated_at';
const SQL_DASH_ATTENTION =
  '(SELECT $46::text AS kind,' + SQL_DASH_ATTENTION_COLUMNS + SQL_DASH_ASSETS +
  ' AND a.state = $42 AND a.due_date < $40::date ORDER BY a.due_date, a.asset_tag_key LIMIT $41)' +
  ' UNION ALL (SELECT $47::text,' + SQL_DASH_ATTENTION_COLUMNS + SQL_DASH_ASSETS +
  ' AND a.state <> $43 AND a.warranty_end >= $40::date AND a.warranty_end <= $40::date + $44::int ORDER BY a.warranty_end, a.asset_tag_key LIMIT $41)' +
  ' UNION ALL (SELECT $48::text,' + SQL_DASH_ATTENTION_COLUMNS + SQL_DASH_ASSETS +
  ' AND a.state = $45 ORDER BY a.updated_at DESC, a.asset_tag_key LIMIT $41)';

// 오늘과 시간대(기업 시간대). 기업 행이 없으면(시스템 관리자가 기업을 고르지 않은 경우) UTC.
const SQL_DASH_TODAY = 'SELECT (now() AT TIME ZONE timezone)::date::text AS today, timezone FROM app.company WHERE id = $1';

// 조건 칩에 보일 이름. 부서는 범위 안의 것만($5).
const SQL_DASH_LABELS =
  'SELECT (SELECT c.name FROM app.category c WHERE c.id = $2::uuid AND c.company_id = $1) AS category,' +
  ' (SELECT m.manufacturer || chr(32) || m.name FROM app.item_model m WHERE m.id = $3::uuid AND m.company_id = $1) AS model,' +
  ' (SELECT d.name FROM app.department d WHERE d.id = $4::uuid AND d.company_id = $1 AND ($5::uuid[] IS NULL OR d.id = ANY($5))) AS department';

// 이력 추이(월별·종류별 건수). 이력 테이블을 (기업, 시각 내림차순) 인덱스 순서로 기간 안에서만, 최근 $43 건까지 읽는다.
// 자산: $1~$39 자산 조건(뺄 상태는 비운다: 등록 취소된 자산의 이력도 센다), $40 시작일, $41 시간대, $42 'month', $43 상한,
//       $44 = 걸 조건이 없음(범위 제한도 조건도 없으면 자산 행을 찾지 않는다). 부서 범위는 지금의 관리 부서로(history.ts 와 같다).
const SQL_DASH_TREND_ASSET =
  'WITH w AS (SELECT t.created_at, t.type, t.asset_id, t.company_id FROM app.asset_txn t' +
  ' WHERE t.company_id = $1 AND t.created_at >= ($40::date::timestamp AT TIME ZONE $41::text)' +
  ' ORDER BY t.created_at DESC, t.seq DESC LIMIT $43)' +
  ' SELECT (date_trunc($42::text, w.created_at AT TIME ZONE $41::text))::date::text AS month, w.type, count(*)::int AS n, (SELECT count(*) FROM w)::int AS scanned' +
  ' FROM w WHERE $44::boolean OR EXISTS (SELECT 1' + SQL_DASH_ASSETS + ' AND a.id = w.asset_id AND a.company_id = w.company_id)' +
  ' GROUP BY 1, 2 ORDER BY 1, 2';
// 주변기기: $1 기업, $2 범위, $3 부서 조건, $4 시작일, $5 시간대, $6 'month', $7 상한, $8 = 걸 조건이 없음.
const SQL_DASH_TREND_PERIPHERAL =
  'WITH w AS (SELECT t.created_at, t.type, t.stock_id, t.company_id FROM app.peripheral_txn t' +
  ' WHERE t.company_id = $1 AND t.created_at >= ($4::date::timestamp AT TIME ZONE $5::text)' +
  ' ORDER BY t.created_at DESC, t.seq DESC LIMIT $7)' +
  ' SELECT (date_trunc($6::text, w.created_at AT TIME ZONE $5::text))::date::text AS month, w.type, count(*)::int AS n, (SELECT count(*) FROM w)::int AS scanned' +
  ' FROM w WHERE $8::boolean OR EXISTS (SELECT 1 FROM app.peripheral_stock s WHERE s.id = w.stock_id AND s.company_id = w.company_id' +
  '   AND ($2::uuid[] IS NULL OR s.department_id = ANY($2)) AND ($3::uuid IS NULL OR s.department_id = $3))' +
  ' GROUP BY 1, 2 ORDER BY 1, 2';

// 주변기기 재고: 카테고리별 보유·대여 수량(위 $4 개)과, 창 함수로 구한 전체 합계(LIMIT 전에 계산된다). $3 = 부서 조건.
const SQL_DASH_PERIPHERAL_CATEGORIES =
  'SELECT c.id, c.name, sum(s.on_hand_qty)::int AS on_hand, sum(s.on_loan_qty)::int AS on_loan,' +
  ' (sum(sum(s.on_hand_qty)) OVER ())::int AS all_on_hand, (sum(sum(s.on_loan_qty)) OVER ())::int AS all_on_loan,' +
  ' (sum(count(*)) OVER ())::int AS all_rows, (count(*) OVER ())::int AS categories' +
  ' FROM app.peripheral_stock s JOIN app.item_model m ON m.id = s.model_id AND m.company_id = s.company_id' +
  ' JOIN app.category c ON c.id = m.category_id AND c.company_id = s.company_id' +
  ' WHERE s.company_id = $1 AND ($2::uuid[] IS NULL OR s.department_id = ANY($2)) AND ($3::uuid IS NULL OR s.department_id = $3)' +
  ' GROUP BY c.id, c.name ORDER BY sum(s.on_hand_qty + s.on_loan_qty) DESC, lower(c.name), c.id LIMIT $4';
const SQL_DASH_LOANS =
  'SELECT count(*)::int AS open, count(*) FILTER (WHERE l.due_date < $3::date)::int AS overdue' +
  ' FROM app.peripheral_loan l JOIN app.peripheral_stock s ON s.id = l.stock_id AND s.company_id = l.company_id' +
  ' WHERE l.company_id = $1 AND l.status = $4 AND ($2::uuid[] IS NULL OR s.department_id = ANY($2)) AND ($5::uuid IS NULL OR s.department_id = $5)';
// 한계 수량은 그 화면과 같은 규칙으로 보인다: 범위가 제한된 사용자는 자기 부서 것만(기업 전체 것은 보이지 않는다). $4 = 부서 조건.
const SQL_DASH_THRESHOLDS =
  'SELECT count(*) FILTER (WHERE t.is_active)::int AS active, count(*) FILTER (WHERE t.is_active AND t.state = $3)::int AS low' +
  ' FROM app.stock_threshold t WHERE t.company_id = $1 AND ($2::uuid[] IS NULL OR t.department_id = ANY($2)) AND ($4::uuid IS NULL OR t.department_id = $4)';
// 부족한 한계 수량(모자란 수가 많은 것부터 $5 행). 수량은 한계 수량 화면과 같은 식(SQL_THRESHOLD_QTY)으로 센다.
const SQL_DASH_LOW_STOCK =
  'SELECT x.* FROM (SELECT t.id, t.category_id, t.model_id, t.department_id, t.min_qty, ' + SQL_THRESHOLD_QTY + ' AS qty,' + SQL_THRESHOLD_TARGET +
  ' FROM app.stock_threshold t' + SQL_THRESHOLD_JOINS +
  ' WHERE t.company_id = $1 AND ($2::uuid[] IS NULL OR t.department_id = ANY($2)) AND t.is_active AND t.state = $3 AND ($4::uuid IS NULL OR t.department_id = $4)) x' +
  ' ORDER BY x.min_qty - x.qty DESC, lower(x.target_name), x.id LIMIT $5';

// ─────────────────────────── 입력 ───────────────────────────

export interface DashboardQuery {
  state?: AssetState;
  substate?: string;
  categoryId?: string;
  modelId?: string;
  departmentId?: string;
  exact?: AssetExactFilter;
  /** 퇴역 자산을 뺀다(보증 구간에서 들어올 때). 목록의 active=true 와 같다. */
  active?: boolean;
  /** DASH_DIMENSIONS 또는 'cf.<키>'. 기본 category */
  dimension?: string;
  trendMonths?: (typeof TREND_MONTHS)[number];
}

const CF_DIMENSION = /^cf\.[a-z][a-z0-9_]{0,39}$/;
/** 모양만 본다(사용자 지정 필드가 이 기업의 정의에 있는지·읽을 수 있는지는 loadDashboard 가 본다). */
export const isDimensionName = (v: string): boolean => (DASH_DIMENSIONS as readonly string[]).includes(v) || CF_DIMENSION.test(v);

// ─────────────────────────── 날짜 ───────────────────────────

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** 이번 달부터 거슬러 n 개월(이번 달 포함)의 첫날들. 오래된 것부터. */
export function trendMonthStarts(today: string, n: number): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ─────────────────────────── 응답 ───────────────────────────

type StateCounts = Partial<Record<string, number>>;
export interface BreakdownGroup {
  /** 묶음 키(카테고리·모델·부서는 ID, 그 밖은 값 그대로). null = 값 없음 */
  key: string | null;
  label: string | null;
  /** 모델의 제조사 */
  label2: string | null;
  total: number;
  /** 상태별 건수 */
  byState: StateCounts;
  /** 재고·사용 가능 */
  available: number;
}

export interface WarrantyBucket {
  key: 'expired' | 'soon' | 'd90' | 'd180' | 'd365' | 'later' | 'none';
  n: number;
  /** 목록 조건: 보증 만료일 범위(양 끝 포함). none 이면 "보증 만료일 없음". 언제나 퇴역 제외(active). */
  from: string | null;
  to: string | null;
}

export interface AgeBucket {
  /** year: 그해, older: to 이전 전부, newer: from 이후 전부(미래 날짜), unknown: 구매일 없음 */
  kind: 'year' | 'older' | 'newer' | 'unknown';
  year: number | null;
  n: number;
  from: string | null;
  to: string | null;
}

export async function loadDashboard(db: Db, actor: Actor, access: DataAccess, query: DashboardQuery = {}) {
  const perms = await actorPermissions(db, actor);
  const can = (resource: string) => perms === null || perms.has(permKey(resource, 'read'));
  const base = [actor.companyId, access.scope];
  const t = (await db.query<{ today: string; timezone: string }>(SQL_DASH_TODAY, [actor.companyId])).rows[0];
  const today = t?.today ?? new Date().toISOString().slice(0, 10);
  const timezone = t?.timezone ?? 'UTC';
  const dimension = query.dimension ?? 'category';
  if (!isDimensionName(dimension)) throw badRequest('묶음 기준이 올바르지 않습니다.');
  const trendMonths = query.trendMonths ?? 12;
  const dept = query.departmentId ?? null;
  const canAssets = can('asset.item');

  let assets = null;
  let labels = null;
  // 자산 조건(목록과 같다). 자산을 읽을 수 없으면 자산 조건을 쓸 곳이 없으므로 준비하지 않는다.
  const filter = canAssets
    ? await prepareAssetFilter(db, actor, access, {
        state: query.state, substate: query.substate, categoryId: query.categoryId, modelId: query.modelId, departmentId: query.departmentId, exact: query.exact, active: query.active,
      })
    : null;

  if (filter) {
    const customKey = dimension.startsWith('cf.') ? resolveCustomKey(dimension, access, filter.defByKey) : null; // 모르는 키 400, 제한 403
    const all = filter.args(query.state ?? null, query.substate ?? null);
    const states = await db.query<{ state: string; substate: string | null; n: number }>(SQL_DASH_STATES, filter.args(null, null));
    const facts = (
      await db.query<Record<string, number>>(SQL_DASH_FACTS, [...all, today, WARRANTY_EDGES[0], 'IN_USE', 'RETIRED', WARRANTY_EDGES[1], WARRANTY_EDGES[2], WARRANTY_EDGES[3]])
    ).rows[0]!;
    const by = await db.query<{ rk: number; k: string | null; l1: string | null; l2: string | null; state: string; substate: string | null; n: number; groups: number }>(
      SQL_DASH_BY[customKey ? 'custom' : dimension] as string,
      customKey ? [...all, BREAKDOWN_TOP, customKey] : [...all, BREAKDOWN_TOP],
    );
    const age = await db.query<{ y: number | null; n: number }>(SQL_DASH_AGE, all);
    const attention = await db.query<{ kind: string; [k: string]: unknown }>(SQL_DASH_ATTENTION, [
      ...all, today, ATTENTION_LIMIT, 'IN_USE', 'RETIRED', WARRANTY_NOTICE_DAYS, 'MISSING', 'overdue', 'warranty', 'missing',
    ]);
    if (query.categoryId || query.modelId || query.departmentId) {
      labels = (await db.query<{ category: string | null; model: string | null; department: string | null }>(SQL_DASH_LABELS, [
        actor.companyId, query.categoryId ?? null, query.modelId ?? null, query.departmentId ?? null, access.scope,
      ])).rows[0] ?? null;
    }

    // 묶음: 순위(rk) 순으로 모은다. rk = 0 은 "기타".
    const groups: BreakdownGroup[] = [];
    let other: { groups: number; total: number; byState: StateCounts } | null = null;
    for (const r of by.rows) {
      if (r.rk === 0) {
        other ??= { groups: 0, total: 0, byState: {} };
        other.groups = Math.max(other.groups, r.groups);
        other.total += r.n;
        other.byState[r.state] = (other.byState[r.state] ?? 0) + r.n;
        continue;
      }
      let g = groups[r.rk - 1];
      if (!g) g = groups[r.rk - 1] = { key: r.k, label: r.l1, label2: r.l2, total: 0, byState: {}, available: 0 };
      g.total += r.n;
      g.byState[r.state] = (g.byState[r.state] ?? 0) + r.n;
      if (r.state === 'IN_STOCK' && r.substate === 'AVAILABLE') g.available += r.n;
    }

    // 핵심 수치: 상태 조건까지 건 수. 도넛(states)은 상태 조건을 뺀 수라서, 상태 조건에 맞는 칸만 남겨 센다.
    const match = (s: { state: string; substate: string | null }) => (!query.state || s.state === query.state) && (!query.substate || s.substate === query.substate);
    const count = (pred: (s: { state: string; substate: string | null }) => boolean) => states.rows.filter((s) => match(s) && pred(s)).reduce((n, s) => n + s.n, 0);

    // 구매 연도 구간: 올해부터 AGE_YEARS 해는 따로(자산이 없는 해도 0 으로), 그 전은 하나로, 미래 날짜는 따로, 구매일 없음.
    const thisYear = Number(today.slice(0, 4));
    const firstYear = thisYear - AGE_YEARS + 1;
    const yearN = new Map<number | null, number>(age.rows.map((r) => [r.y, r.n]));
    const ageBuckets: AgeBucket[] = [];
    const older = age.rows.filter((r) => r.y !== null && r.y < firstYear).reduce((n, r) => n + r.n, 0);
    const newer = age.rows.filter((r) => r.y !== null && r.y > thisYear).reduce((n, r) => n + r.n, 0);
    if (older > 0) ageBuckets.push({ kind: 'older', year: firstYear - 1, n: older, from: null, to: `${firstYear - 1}-12-31` });
    for (let y = firstYear; y <= thisYear; y++) ageBuckets.push({ kind: 'year', year: y, n: yearN.get(y) ?? 0, from: `${y}-01-01`, to: `${y}-12-31` });
    if (newer > 0) ageBuckets.push({ kind: 'newer', year: thisYear + 1, n: newer, from: `${thisYear + 1}-01-01`, to: null });
    ageBuckets.push({ kind: 'unknown', year: null, n: yearN.get(null) ?? 0, from: null, to: null });

    const [e0, e1, e2, e3] = WARRANTY_EDGES;
    const warranty: WarrantyBucket[] = [
      { key: 'expired', n: facts.w_expired!, from: null, to: addDays(today, -1) },
      { key: 'soon', n: facts.w_soon!, from: today, to: addDays(today, e0) },
      { key: 'd90', n: facts.w_d90!, from: addDays(today, e0 + 1), to: addDays(today, e1) },
      { key: 'd180', n: facts.w_d180!, from: addDays(today, e1 + 1), to: addDays(today, e2) },
      { key: 'd365', n: facts.w_d365!, from: addDays(today, e2 + 1), to: addDays(today, e3) },
      { key: 'later', n: facts.w_later!, from: addDays(today, e3 + 1), to: null },
      { key: 'none', n: facts.w_none!, from: null, to: null },
    ];

    const pick = (kind: string) => attention.rows.filter((r) => r.kind === kind).map(({ kind: _k, ...rest }) => rest);
    const nonRetired = (g: BreakdownGroup) => g.total - (g.byState.RETIRED ?? 0);
    assets = {
      total: facts.total!,
      /** 상태 조건을 뺀 (상태, 세부 상태)별 건수(도넛) */
      byState: states.rows,
      kpi: {
        total: facts.total!,
        inUse: count((s) => s.state === 'IN_USE'),
        available: count((s) => s.state === 'IN_STOCK' && s.substate === 'AVAILABLE'),
        inStock: count((s) => s.state === 'IN_STOCK'),
        maintenance: count((s) => s.state === 'MAINTENANCE'),
        missing: count((s) => s.state === 'MISSING'),
        retired: count((s) => s.state === 'RETIRED'),
        onOrder: count((s) => s.state === 'ON_ORDER'),
      },
      overdue: facts.overdue!,
      warrantySoon: facts.w_soon!,
      warrantyWindowDays: WARRANTY_NOTICE_DAYS,
      breakdown: { dimension, top: BREAKDOWN_TOP, groups, other },
      // 예전 카테고리 막대(카테고리 기준일 때만). 퇴역·등록 취소는 뺀다.
      byCategory:
        dimension === 'category'
          ? groups.map((g) => ({ id: g.key, name: g.label, available: g.available, in_use: g.byState.IN_USE ?? 0, total: nonRetired(g) })).filter((g) => g.total > 0)
          : null,
      age: ageBuckets,
      warranty,
      attention: { overdue: pick('overdue'), warranty: pick('warranty'), missing: pick('missing') },
      fields: { dimensions: DASH_DIMENSIONS, custom: filter.fields.custom },
    };
  }

  // 이력 추이: 이력 조회 권한과 그 자료(자산·주변기기)의 조회 권한이 함께 있어야 한다.
  let trend = null;
  const trendAsset = filter && can('history.stock');
  const trendPeripheral = can('peripheral.stock') && can('history.stock');
  if (trendAsset || trendPeripheral) {
    const months = trendMonthStarts(today, trendMonths);
    const start = months[0]!;
    let truncated = false;
    let assetRows = null;
    let peripheralRows = null;
    if (trendAsset && filter) {
      const r = await db.query<{ month: string; type: string; n: number; scanned: number }>(SQL_DASH_TREND_ASSET, [
        ...filter.args(query.state ?? null, query.substate ?? null, query.active ? ['RETIRED'] : []), start, timezone, 'month', TREND_SCAN_CAP, access.scope === null && !filter.hasConditions,
      ]);
      truncated ||= r.rows.some((x) => x.scanned >= TREND_SCAN_CAP);
      assetRows = r.rows.map(({ month, type, n }) => ({ month, type, n }));
    }
    if (trendPeripheral) {
      const r = await db.query<{ month: string; type: string; n: number; scanned: number }>(SQL_DASH_TREND_PERIPHERAL, [
        ...base, dept, start, timezone, 'month', TREND_SCAN_CAP, access.scope === null && dept === null,
      ]);
      truncated ||= r.rows.some((x) => x.scanned >= TREND_SCAN_CAP);
      peripheralRows = r.rows.map(({ month, type, n }) => ({ month, type, n }));
    }
    trend = { months, timezone, asset: assetRows, peripheral: peripheralRows, truncated, scanCap: TREND_SCAN_CAP };
  }

  let peripherals = null;
  let peripheralCategories = null;
  if (can('peripheral.stock')) {
    const r = await db.query<{ id: string; name: string; on_hand: number; on_loan: number; all_on_hand: number; all_on_loan: number; all_rows: number; categories: number }>(
      SQL_DASH_PERIPHERAL_CATEGORIES, [...base, dept, PERIPHERAL_CATEGORY_LIMIT],
    );
    const first = r.rows[0];
    peripherals = { onHand: first?.all_on_hand ?? 0, onLoan: first?.all_on_loan ?? 0, stockRows: first?.all_rows ?? 0 };
    peripheralCategories = { categories: first?.categories ?? 0, rows: r.rows.map((x) => ({ id: x.id, name: x.name, onHand: x.on_hand, onLoan: x.on_loan })) };
  }

  let loans = null;
  if (can('peripheral.loan')) {
    const r = await db.query<{ open: number; overdue: number }>(SQL_DASH_LOANS, [...base, today, 'OPEN', dept]);
    loans = { open: r.rows[0]?.open ?? 0, overdue: r.rows[0]?.overdue ?? 0 };
  }

  let thresholds = null;
  let lowStock = null;
  if (can('threshold')) {
    const r = await db.query<{ active: number; low: number }>(SQL_DASH_THRESHOLDS, [...base, 'LOW', dept]);
    thresholds = { active: r.rows[0]?.active ?? 0, low: r.rows[0]?.low ?? 0 };
    lowStock = thresholds.low > 0 ? (await db.query(SQL_DASH_LOW_STOCK, [...base, 'LOW', dept, LOW_STOCK_LIMIT])).rows : [];
  }

  return { today, scoped: !access.unrestricted, labels, assets, trend, peripherals, peripheralCategories, loans, thresholds, lowStock };
}
