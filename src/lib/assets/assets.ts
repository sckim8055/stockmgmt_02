// 자산(한 행이 실물 한 대). 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 이 파일의 모든 조회·변경은 두 가지를 반드시 거친다.
//   1) 부서 범위: access.scope 를 SQL 조건에 넣는다. 범위 밖 자산은 "없는 것"으로 응답한다(404).
//   2) 제한 필드: 읽기 권한이 없는 필드는 응답에서 빼고(present), 정렬·검색에도 쓸 수 없게 한다.
import type { Db } from '@/lib/db/context';
import { evaluateForModel, evaluateForTargets } from '@/lib/alerts/thresholds';
import { companyToday } from '@/lib/alerts/today';
import { writeAudit } from '@/lib/auth/audit';
import type { DataAccess, RestrictedField } from '@/lib/authz/scope';
import { HttpError, badRequest, forbidden, notFound } from '@/lib/http/errors';
import { hasNul, isIsoDate } from '@/lib/validation';
import type { Actor } from '@/lib/http/route';
import { applyAction, TransitionError, type ActionInput, type AssetAction, type AssetState, type AssetSubstate } from './transitions';

// ─────────────────────────── SQL (상수로만 조립) ───────────────────────────

const SQL_ASSET_COLUMNS =
  ' a.id, a.asset_tag, a.serial_number, a.state, a.substate, a.location, a.due_date::text AS due_date,' +
  ' a.purchase_date::text AS purchase_date, a.purchase_price::float8 AS purchase_price, a.supplier,' +
  ' a.warranty_end::text AS warranty_end, a.custom, a.created_at, a.updated_at,' +
  ' a.model_id, m.manufacturer, m.name AS model_name, c.id AS category_id, c.name AS category_name,' +
  ' a.department_id, d.name AS department_name,' +
  ' a.holder_person_id, p.name AS holder_name, p.employee_no AS holder_employee_no ';

const SQL_ASSET_FROM =
  ' FROM app.asset a' +
  ' JOIN app.item_model m ON m.id = a.model_id' +
  ' JOIN app.category c ON c.id = m.category_id' +
  ' JOIN app.department d ON d.id = a.department_id' +
  ' LEFT JOIN app.person p ON p.id = a.holder_person_id ';

// $1 기업, $2 부서 범위(null = 전체). 이 두 조건은 자산을 읽는 모든 쿼리에 들어간다.
const SQL_ASSET_VISIBLE = ' a.company_id = $1 AND ($2::uuid[] IS NULL OR a.department_id = ANY($2)) ';

// 목록·건수·상태별 요약이 같은 조건을 쓴다. 매개변수 번호는 ASSET_FILTER_SLOTS 와 listAssets 의 배열 순서와 같다.
// $12~$24: 열별 "포함" 조건. 각각 LIKE 패턴의 배열이고 모두 맞아야 한다(빈 배열 = 조건 없음).
//          한 열에 열 필터와 "이 필드에서 검색"이 함께 오면 패턴이 둘이 된다.
// $25, $26: 사용자 지정 필드 조건. 키 배열과 패턴 배열(같은 길이). 키는 기업의 정의로 검증한 뒤 매개변수로만 넘긴다.
// (RLS 아래에서 ILIKE·->> 는 인덱스를 쓰지 못한다. 기업의 자산을 한 번 훑는다 — docs/REVIEW-phase5.md)
const SQL_ASSET_FILTERS =
  ' AND ($3::text IS NULL OR a.state = $3)' +
  ' AND ($4::text IS NULL OR a.substate = $4)' +
  ' AND ($5::uuid IS NULL OR a.model_id = $5)' +
  ' AND ($6::uuid IS NULL OR m.category_id = $6)' +
  ' AND ($7::uuid IS NULL OR a.department_id = $7)' +
  ' AND ($8::uuid IS NULL OR a.holder_person_id = $8)' +
  // 전체 필드 검색. 제한 필드(공급업체·구매가·제한된 사용자 지정 필드)는 넣지 않는다. 검색 결과로 값을 추정할 수 있기 때문이다.
  ' AND ($9::text IS NULL OR a.asset_tag ILIKE $9 OR a.serial_number ILIKE $9 OR a.location ILIKE $9' +
  '      OR m.name ILIKE $9 OR m.manufacturer ILIKE $9 OR p.name ILIKE $9' +
  '      OR c.name ILIKE $9 OR d.name ILIKE $9 OR p.employee_no ILIKE $9)' +
  // $10 = 목록에서 뺄 상태들. 등록 취소(VOID)된 자산은 따로 요청할 때만 보인다.
  ' AND a.state <> ALL($10::text[])' +
  // $11 = 오늘(기업 시간대). 값이 있으면 반납 기한이 지난 대여만.
  " AND ($11::date IS NULL OR (a.state = 'IN_USE' AND a.due_date < $11::date))" +
  ' AND (cardinality($12::text[]) = 0 OR a.asset_tag ILIKE ALL($12::text[]))' +
  ' AND (cardinality($13::text[]) = 0 OR c.name ILIKE ALL($13::text[]))' +
  ' AND (cardinality($14::text[]) = 0 OR m.manufacturer ILIKE ALL($14::text[]))' +
  ' AND (cardinality($15::text[]) = 0 OR m.name ILIKE ALL($15::text[]))' +
  ' AND (cardinality($16::text[]) = 0 OR a.serial_number ILIKE ALL($16::text[]))' +
  // 보유자: 이름 또는 사번. 줄바꿈으로 이어 붙여 비교한다(검색어에는 제어 문자가 없으므로 두 값에 걸쳐 맞을 수 없다).
  ' AND (cardinality($17::text[]) = 0 OR concat_ws(chr(10), p.name, p.employee_no) ILIKE ALL($17::text[]))' +
  ' AND (cardinality($18::text[]) = 0 OR p.employee_no ILIKE ALL($18::text[]))' +
  ' AND (cardinality($19::text[]) = 0 OR d.name ILIKE ALL($19::text[]))' +
  ' AND (cardinality($20::text[]) = 0 OR a.location ILIKE ALL($20::text[]))' +
  // 제한 필드. listAssets 가 읽기 권한을 확인한 뒤에만 패턴을 넣는다(권한이 없으면 403).
  ' AND (cardinality($21::text[]) = 0 OR a.supplier ILIKE ALL($21::text[]))' +
  ' AND (cardinality($22::text[]) = 0 OR a.purchase_price::text ILIKE ALL($22::text[]))' +
  ' AND (cardinality($23::text[]) = 0 OR a.purchase_date::text ILIKE ALL($23::text[]))' +
  ' AND (cardinality($24::text[]) = 0 OR a.warranty_end::text ILIKE ALL($24::text[]))' +
  // 키 배열이 비었는지를 먼저 보는 것은 실행 계획 때문이다. 조건이 없을 때 하위 쿼리가 계획에서 빠지지 않으면
  // 행 수 추정이 1로 떨어져 조인 순서가 나빠진다(자산 2,000대에서 첫 쪽 53ms → 약 6ms).
  ' AND (cardinality($25::text[]) = 0 OR NOT EXISTS (SELECT 1 FROM unnest($25::text[], $26::text[]) AS f(k, pat)' +
  '      WHERE (a.custom ->> f.k) IS NULL OR NOT ((a.custom ->> f.k) ILIKE f.pat))) ';

const SQL_ASSET_LIST_BASE = 'SELECT' + SQL_ASSET_COLUMNS + SQL_ASSET_FROM + 'WHERE' + SQL_ASSET_VISIBLE + SQL_ASSET_FILTERS;
// 같은 값끼리는 자산 태그(기업 안에서 고유)로 순서를 정한다. 그래야 쪽을 넘겨도 행이 겹치거나 빠지지 않는다.
const SQL_ASSET_PAGE = ', a.asset_tag_key ASC, a.id LIMIT $27 OFFSET $28';
const SQL_ASSET_COUNT = 'SELECT count(*)::int AS n' + SQL_ASSET_FROM + 'WHERE' + SQL_ASSET_VISIBLE + SQL_ASSET_FILTERS;
// 상태별 건수(한눈에 보는 상태). 상태 조건($3, $4)은 비워서 부르고 나머지 조건은 목록과 같다. 결과는 (상태, 세부 상태) 조합 수만큼(10행 남짓).
const SQL_ASSET_SUMMARY =
  'SELECT a.state, a.substate, count(*)::int AS n' + SQL_ASSET_FROM + 'WHERE' + SQL_ASSET_VISIBLE + SQL_ASSET_FILTERS + ' GROUP BY a.state, a.substate';

// 정렬은 이 목록에 있는 것만 허용한다. 입력값이 SQL 에 들어가지 않는다.
const SQL_ASSET_LIST_BY: Record<string, string> = {
  'asset_tag:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(a.asset_tag) ASC' + SQL_ASSET_PAGE,
  'asset_tag:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(a.asset_tag) DESC' + SQL_ASSET_PAGE,
  'state:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.state ASC, a.substate ASC NULLS FIRST' + SQL_ASSET_PAGE,
  'state:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.state DESC, a.substate DESC NULLS LAST' + SQL_ASSET_PAGE,
  'model:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(m.manufacturer) ASC, lower(m.name) ASC' + SQL_ASSET_PAGE,
  'model:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(m.manufacturer) DESC, lower(m.name) DESC' + SQL_ASSET_PAGE,
  'category:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(c.name) ASC' + SQL_ASSET_PAGE,
  'category:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(c.name) DESC' + SQL_ASSET_PAGE,
  'manufacturer:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(m.manufacturer) ASC' + SQL_ASSET_PAGE,
  'manufacturer:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(m.manufacturer) DESC' + SQL_ASSET_PAGE,
  'serial:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(a.serial_number) ASC NULLS LAST' + SQL_ASSET_PAGE,
  'serial:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(a.serial_number) DESC NULLS LAST' + SQL_ASSET_PAGE,
  'department:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(d.name) ASC' + SQL_ASSET_PAGE,
  'department:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(d.name) DESC' + SQL_ASSET_PAGE,
  'holder:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(p.name) ASC NULLS LAST' + SQL_ASSET_PAGE,
  'holder:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(p.name) DESC NULLS LAST' + SQL_ASSET_PAGE,
  'employee_no:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(p.employee_no) ASC NULLS LAST' + SQL_ASSET_PAGE,
  'employee_no:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(p.employee_no) DESC NULLS LAST' + SQL_ASSET_PAGE,
  'location:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(a.location) ASC NULLS LAST' + SQL_ASSET_PAGE,
  'location:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(a.location) DESC NULLS LAST' + SQL_ASSET_PAGE,
  'warranty_end:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.warranty_end ASC NULLS LAST' + SQL_ASSET_PAGE,
  'warranty_end:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.warranty_end DESC NULLS LAST' + SQL_ASSET_PAGE,
  'purchase_date:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.purchase_date ASC NULLS LAST' + SQL_ASSET_PAGE,
  'purchase_date:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.purchase_date DESC NULLS LAST' + SQL_ASSET_PAGE,
  'due_date:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.due_date ASC NULLS LAST' + SQL_ASSET_PAGE,
  'due_date:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.due_date DESC NULLS LAST' + SQL_ASSET_PAGE,
  'created_at:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.created_at ASC' + SQL_ASSET_PAGE,
  'created_at:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.created_at DESC' + SQL_ASSET_PAGE,
  'updated_at:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.updated_at ASC' + SQL_ASSET_PAGE,
  'updated_at:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.updated_at DESC' + SQL_ASSET_PAGE,
  // 제한 필드로 정렬하려면 그 필드의 읽기 권한이 있어야 한다(listAssets 에서 검사).
  'purchase_price:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.purchase_price ASC NULLS LAST' + SQL_ASSET_PAGE,
  'purchase_price:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.purchase_price DESC NULLS LAST' + SQL_ASSET_PAGE,
  'supplier:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(a.supplier) ASC NULLS LAST' + SQL_ASSET_PAGE,
  'supplier:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(a.supplier) DESC NULLS LAST' + SQL_ASSET_PAGE,
};
export const ASSET_SORT_KEYS = [
  'asset_tag', 'state', 'model', 'category', 'manufacturer', 'serial', 'department', 'holder', 'employee_no', 'location',
  'warranty_end', 'purchase_date', 'due_date', 'created_at', 'updated_at', 'purchase_price', 'supplier',
] as const;
export type AssetSortKey = (typeof ASSET_SORT_KEYS)[number];

/**
 * 글자로 검색·거를 수 있는 기본 열. 값은 SQL_ASSET_FILTERS 의 매개변수 번호($12~$24)와 짝이다.
 * 열 필터 매개변수 이름은 `f_<열>`(예: f_asset_tag=NB-0), 사용자 지정 필드는 `f_cf.<키>`(예: f_cf.mac=aa:bb).
 * qField 도 같은 이름을 쓴다(qField=serial, qField=cf.mac). qField=all(기본)은 $9 의 전체 필드 검색이다.
 */
export const ASSET_FILTER_SLOTS = {
  asset_tag: 12, category: 13, manufacturer: 14, model: 15, serial: 16, holder: 17, employee_no: 18,
  department: 19, location: 20, supplier: 21, purchase_price: 22, purchase_date: 23, warranty_end: 24,
} as const;
export type AssetTextField = keyof typeof ASSET_FILTER_SLOTS;
export const ASSET_TEXT_FIELDS = Object.keys(ASSET_FILTER_SLOTS) as AssetTextField[];
/** 사용자 지정 필드를 가리키는 이름의 앞붙이. 키 형식은 custom_field_def.key 의 CHECK 와 같다. */
export const CUSTOM_FIELD_PREFIX = 'cf.';
export const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** 한 요청에서 받는 사용자 지정 필드 조건 수 상한 */
const MAX_CUSTOM_FILTERS = 20;

/** 읽기 권한이 있어야 검색·필터·정렬에 쓸 수 있는 기본 열 */
const RESTRICTED_COLUMN: Partial<Record<AssetTextField | AssetSortKey, RestrictedField>> = {
  supplier: 'supplier',
  purchase_price: 'purchase_price',
};

const SQL_ASSET_ONE = 'SELECT' + SQL_ASSET_COLUMNS + SQL_ASSET_FROM + 'WHERE' + SQL_ASSET_VISIBLE + 'AND a.id = $3';

// 변경 전에 행을 잠그고 범위를 확인한다. (FOR NO KEY UPDATE: 다른 트랜잭션의 외래키 검사와 교착하지 않는다)
const SQL_ASSET_LOCK =
  'SELECT a.id, a.state, a.substate, a.holder_person_id, a.department_id, a.location, a.due_date::text AS due_date' +
  ' FROM app.asset a WHERE' + SQL_ASSET_VISIBLE + 'AND a.id = $3 FOR NO KEY UPDATE OF a';

// ─────────────────────────── 표현 (제한 필드 제거) ───────────────────────────

interface CustomDef {
  key: string;
  data_type: 'text' | 'number' | 'date' | 'boolean';
  is_restricted: boolean;
}

async function loadCustomDefs(db: Db): Promise<CustomDef[]> {
  const { rows } = await db.query<CustomDef>('SELECT key, data_type, is_restricted FROM app.custom_field_def WHERE is_active');
  return rows;
}

interface ListedCustomDef extends CustomDef {
  label: string;
}

// 목록의 검색·필터·열 머리에 쓰는 정의. 이 기업의 사용 중인 필드만(RLS 에 더해 기업 조건을 직접 건다).
const SQL_CUSTOM_DEFS_FOR_LIST =
  'SELECT key, label, data_type, is_restricted FROM app.custom_field_def WHERE company_id = $1 AND is_active ORDER BY sort_order, key';

async function loadListCustomDefs(db: Db, actor: Actor): Promise<ListedCustomDef[]> {
  return (await db.query<ListedCustomDef>(SQL_CUSTOM_DEFS_FOR_LIST, [actor.companyId])).rows;
}

type AssetRow = Record<string, unknown> & { custom: Record<string, unknown> };

/** 읽기 권한이 없는 제한 필드를 응답에서 뺀다. 값을 가리는(***) 것이 아니라 키 자체를 없앤다. */
function present(row: AssetRow, access: DataAccess, defs: CustomDef[]): AssetRow {
  const out: AssetRow = { ...row, custom: { ...row.custom } };
  if (!access.canReadField('purchase_price')) delete out.purchase_price;
  if (!access.canReadField('supplier')) delete out.supplier;
  const known = new Map(defs.map((d) => [d.key, d]));
  for (const key of Object.keys(out.custom)) {
    const def = known.get(key);
    // 정의가 없어진(비활성) 필드는 내려주지 않는다. 제한 필드는 권한이 있을 때만.
    if (!def || (def.is_restricted && !access.canReadField('custom_restricted'))) delete out.custom[key];
  }
  return out;
}

// ─────────────────────────── 조회 ───────────────────────────

export interface AssetListQuery {
  state?: AssetState;
  substate?: string;
  modelId?: string;
  categoryId?: string;
  departmentId?: string;
  holderPersonId?: string;
  q?: string;
  /** q 를 찾을 필드: 'all'(기본) | ASSET_TEXT_FIELDS | 'cf.<키>' */
  qField?: string;
  /** 열별 "포함" 조건. 키는 ASSET_TEXT_FIELDS 또는 'cf.<키>', 값은 그 열에 들어 있어야 할 글자. 모두 AND. */
  filters?: Record<string, string>;
  includeVoid?: boolean;
  /** 반납 기한이 지난 대여만 */
  overdue?: boolean;
  sort?: AssetSortKey;
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/** 상태별 건수. 상태 조건만 빼고 나머지 조건(범위·검색·필터 등)은 목록과 같다. */
export interface AssetSummary {
  total: number;
  byState: Partial<Record<AssetState, number>>;
  /** 재고(IN_STOCK)의 세부 상태별 건수 */
  inStock: Partial<Record<string, number>>;
}

/**
 * 이 사용자가 목록에서 볼 수 있는(=검색·필터할 수 있는) 열. 화면은 이것으로 머리·필터 칸을 그린다.
 * 제한 필드는 present() 와 같이, 읽을 수 없으면 키 자체를 넣지 않는다.
 */
export interface AssetListFields {
  supplier?: true;
  purchasePrice?: true;
  custom: { key: string; label: string; data_type: CustomDef['data_type'] }[];
}

/** LIKE 패턴 문자를 글자 그대로 검색하도록 이스케이프한다. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

const canUseCustom = (def: CustomDef, access: DataAccess) => !def.is_restricted || access.canReadField('custom_restricted');

type FieldRef = { kind: 'builtin'; field: AssetTextField } | { kind: 'custom'; key: string };

/**
 * 검색·필터 대상 이름을 확인한다. 모르는 이름·정의에 없는(또는 비활성·다른 기업의) 사용자 지정 필드는 400,
 * 읽기 권한이 없는 제한 필드는 403. 권한 없는 필드로 거르면 결과 건수로 숨긴 값을 알아낼 수 있기 때문이다.
 */
function resolveField(name: string, access: DataAccess, defs: Map<string, CustomDef>): FieldRef {
  if (Object.hasOwn(ASSET_FILTER_SLOTS, name)) {
    const field = name as AssetTextField;
    const restricted = RESTRICTED_COLUMN[field];
    if (restricted && !access.canReadField(restricted)) throw forbidden('읽을 권한이 없는 필드로는 검색할 수 없습니다.');
    return { kind: 'builtin', field };
  }
  if (name.startsWith(CUSTOM_FIELD_PREFIX)) {
    const key = name.slice(CUSTOM_FIELD_PREFIX.length);
    const def = CUSTOM_KEY_RE.test(key) ? defs.get(key) : undefined;
    if (!def) throw badRequest('정의되지 않은 사용자 지정 필드입니다.');
    if (!canUseCustom(def, access)) throw forbidden('읽을 권한이 없는 필드로는 검색할 수 없습니다.');
    return { kind: 'custom', key };
  }
  throw badRequest('검색할 필드가 올바르지 않습니다.');
}

export async function listAssets(
  db: Db,
  actor: Actor,
  access: DataAccess,
  query: AssetListQuery,
): Promise<{ total: number; page: number; pageSize: number; items: AssetRow[]; summary: AssetSummary; fields: AssetListFields }> {
  const sort = query.sort ?? 'asset_tag';
  const sortRestricted = RESTRICTED_COLUMN[sort];
  if (sortRestricted && !access.canReadField(sortRestricted)) {
    throw forbidden(sort === 'purchase_price' ? '구매가로 정렬할 권한이 없습니다.' : '읽을 권한이 없는 필드로는 정렬할 수 없습니다.');
  }
  const sortKey = `${sort}:${query.order ?? 'asc'}`;
  if (!Object.hasOwn(SQL_ASSET_LIST_BY, sortKey)) throw badRequest('정렬 기준이 올바르지 않습니다.');
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);

  const defs = await loadListCustomDefs(db, actor);
  const defByKey = new Map(defs.map((d) => [d.key, d]));

  // 열별 조건을 모은다. 한 열에 여러 패턴이 오면 모두 맞아야 한다.
  const builtin = new Map<AssetTextField, string[]>(ASSET_TEXT_FIELDS.map((f) => [f, []]));
  const customKeys: string[] = [];
  const customPats: string[] = [];
  const add = (name: string, raw: string) => {
    const ref = resolveField(name, access, defByKey);
    const text = raw.trim();
    if (!text) return;
    if (ref.kind === 'builtin') builtin.get(ref.field)!.push(likePattern(text));
    else {
      customKeys.push(ref.key);
      customPats.push(likePattern(text));
    }
  };
  for (const [name, value] of Object.entries(query.filters ?? {})) add(name, value);
  const q = query.q?.trim() || null;
  const qField = query.qField ?? 'all';
  let qAll: string | null = null;
  if (qField === 'all') qAll = q ? likePattern(q) : null;
  else if (q) add(qField, q);
  else resolveField(qField, access, defByKey); // 검색어가 없어도 필드 이름은 검사한다(잘못된 요청을 조용히 넘기지 않는다)
  if (customKeys.length > MAX_CUSTOM_FILTERS) throw badRequest('사용자 지정 필드 조건이 너무 많습니다.');

  const today = query.overdue ? await companyToday(db, actor.companyId) : null;
  const filters = (state: string | null, substate: string | null) => [
    actor.companyId,
    access.scope,
    state,
    substate,
    query.modelId ?? null,
    query.categoryId ?? null,
    query.departmentId ?? null,
    query.holderPersonId ?? null,
    qAll,
    query.includeVoid ? [] : ['VOID'],
    today,
    ...ASSET_TEXT_FIELDS.map((f) => builtin.get(f)!),
    customKeys,
    customPats,
  ];
  const listed = filters(query.state ?? null, query.substate ?? null);

  const count = await db.query<{ n: number }>(SQL_ASSET_COUNT, listed);
  const rows = await db.query<AssetRow>(SQL_ASSET_LIST_BY[sortKey] as string, [...listed, pageSize, (page - 1) * pageSize]);
  const groups = await db.query<{ state: AssetState; substate: string | null; n: number }>(SQL_ASSET_SUMMARY, filters(null, null));

  const summary: AssetSummary = { total: 0, byState: {}, inStock: {} };
  for (const g of groups.rows) {
    summary.total += g.n;
    summary.byState[g.state] = (summary.byState[g.state] ?? 0) + g.n;
    if (g.state === 'IN_STOCK' && g.substate) summary.inStock[g.substate] = (summary.inStock[g.substate] ?? 0) + g.n;
  }
  const fields: AssetListFields = {
    custom: defs.filter((d) => canUseCustom(d, access)).map((d) => ({ key: d.key, label: d.label, data_type: d.data_type })),
  };
  if (access.canReadField('supplier')) fields.supplier = true;
  if (access.canReadField('purchase_price')) fields.purchasePrice = true;
  return { total: count.rows[0]?.n ?? 0, page, pageSize, items: rows.rows.map((r) => present(r, access, defs)), summary, fields };
}

export async function getAsset(db: Db, actor: Actor, access: DataAccess, assetId: string): Promise<AssetRow> {
  const { rows } = await db.query<AssetRow>(SQL_ASSET_ONE, [actor.companyId, access.scope, assetId]);
  const row = rows[0];
  if (!row) throw notFound(); // 다른 기업, 범위 밖 부서, 없는 ID 모두 같은 응답
  return present(row, access, await loadCustomDefs(db));
}

export async function listAssetHistory(db: Db, actor: Actor, access: DataAccess, assetId: string): Promise<unknown[]> {
  const visible = await db.query(SQL_ASSET_ONE, [actor.companyId, access.scope, assetId]);
  if (!visible.rowCount) throw notFound();
  const { rows } = await db.query(
    `SELECT t.id, t.type, t.from_state, t.to_state, t.from_substate, t.to_substate,
            t.from_location, t.to_location, t.note, t.created_at,
            fh.name AS from_holder_name, th.name AS to_holder_name,
            fd.name AS from_department_name, td.name AS to_department_name,
            u.display_name AS actor_name
       FROM app.asset_txn t
       LEFT JOIN app.person fh ON fh.id = t.from_holder_id
       LEFT JOIN app.person th ON th.id = t.to_holder_id
       LEFT JOIN app.department fd ON fd.id = t.from_department_id
       LEFT JOIN app.department td ON td.id = t.to_department_id
       LEFT JOIN app.app_user u ON u.id = t.actor_id
      WHERE t.asset_id = $1 AND t.company_id = $2
      ORDER BY t.created_at DESC, t.seq DESC
      LIMIT 500`,
    [assetId, actor.companyId],
  );
  return rows;
}

// ─────────────────────────── 입력 검증 ───────────────────────────

const MAX_CUSTOM_KEYS = 100;

/**
 * 사용자 지정 필드 입력을 검증한다. 정의에 없는 키, 형식이 맞지 않는 값, 권한 없는 제한 필드는 거부한다.
 * 값이 null 이면 그 키를 지운다는 뜻이다.
 */
function validateCustom(input: Record<string, unknown>, defs: CustomDef[], access: DataAccess): Record<string, unknown> {
  const known = new Map(defs.map((d) => [d.key, d]));
  const out: Record<string, unknown> = {};
  if (Object.keys(input).length > MAX_CUSTOM_KEYS) throw badRequest('사용자 지정 필드가 너무 많습니다.');
  for (const [key, value] of Object.entries(input)) {
    const def = known.get(key);
    if (!def) throw badRequest(`정의되지 않은 사용자 지정 필드입니다: ${key}`);
    if (def.is_restricted && !access.canUpdateField('custom_restricted')) {
      throw forbidden('제한된 사용자 지정 필드를 입력할 권한이 없습니다.');
    }
    if (value === null) {
      out[key] = null;
      continue;
    }
    const ok =
      (def.data_type === 'text' && typeof value === 'string' && value.length <= 500 && !hasNul(value)) ||
      (def.data_type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (def.data_type === 'date' && isIsoDate(value)) ||
      (def.data_type === 'boolean' && typeof value === 'boolean');
    if (!ok) throw badRequest(`사용자 지정 필드의 값 형식이 올바르지 않습니다: ${key}`);
    out[key] = value;
  }
  return out;
}

async function assertAssetModel(db: Db, actor: Actor, modelId: string): Promise<void> {
  const { rowCount } = await db.query(
    "SELECT 1 FROM app.item_model WHERE id = $1 AND company_id = $2 AND kind = 'ASSET' AND is_active FOR SHARE",
    [modelId, actor.companyId],
  );
  if (!rowCount) throw badRequest('선택할 수 없는 모델입니다. (자산용 모델만 가능합니다)');
}

async function assertActiveDepartment(db: Db, actor: Actor, departmentId: string): Promise<void> {
  const { rowCount } = await db.query('SELECT 1 FROM app.department WHERE id = $1 AND company_id = $2 AND is_active FOR SHARE', [
    departmentId,
    actor.companyId,
  ]);
  if (!rowCount) throw badRequest('선택할 수 없는 부서입니다.');
}

// 소문자로 저장해 둔 열(asset_tag_key, serial_key)과 비교한다. lower(열) 로 비교하면 RLS 때문에 인덱스를 쓰지 못한다(0008 마이그레이션 설명).
async function assertUnique(db: Db, actor: Actor, v: { assetTag?: string; modelId?: string; serial?: string | null }, exceptId: string | null): Promise<void> {
  if (v.assetTag !== undefined) {
    const r = await db.query('SELECT 1 FROM app.asset WHERE company_id = $1 AND asset_tag_key = lower($2) AND ($3::uuid IS NULL OR id <> $3)', [
      actor.companyId,
      v.assetTag,
      exceptId,
    ]);
    // 범위 밖 자산과 겹쳐도 같은 메시지다. 자산 태그는 기업 전체에서 고유해야 하므로 존재 사실 자체는 알려줄 수밖에 없다.
    if (r.rowCount) throw new HttpError(409, 'DUPLICATE', '이미 사용 중인(또는 과거에 사용한) 자산 태그입니다.');
  }
  if (v.serial && v.modelId) {
    const r = await db.query(
      'SELECT 1 FROM app.asset WHERE company_id = $1 AND model_id = $2 AND serial_key = lower($3) AND ($4::uuid IS NULL OR id <> $4)',
      [actor.companyId, v.modelId, v.serial, exceptId],
    );
    if (r.rowCount) throw new HttpError(409, 'DUPLICATE', '같은 모델에 같은 시리얼 번호가 이미 있습니다.');
  }
}

// ─────────────────────────── 등록 ───────────────────────────

export interface CreateAssetInput {
  modelId: string;
  assetTag: string;
  serialNumber?: string | null;
  initialState?: 'IN_STOCK' | 'ON_ORDER';
  departmentId?: string | null;
  location?: string | null;
  purchaseDate?: string | null;
  purchasePrice?: number | null;
  supplier?: string | null;
  warrantyEnd?: string | null;
  custom?: Record<string, unknown>;
}

function assertRestrictedWritable(access: DataAccess, input: { purchasePrice?: unknown; supplier?: unknown }): void {
  if (input.purchasePrice !== undefined && !access.canUpdateField('purchase_price')) throw forbidden('구매가를 입력할 권한이 없습니다.');
  if (input.supplier !== undefined && !access.canUpdateField('supplier')) throw forbidden('공급업체를 입력할 권한이 없습니다.');
}

export async function createAsset(db: Db, actor: Actor, access: DataAccess, input: CreateAssetInput): Promise<string> {
  assertRestrictedWritable(access, input);
  await assertAssetModel(db, actor, input.modelId);

  // 관리 부서: 지정하지 않으면 기본 부서(IT). 범위가 제한된 사용자는 자기 범위 안의 부서에만 등록할 수 있다.
  let departmentId = input.departmentId ?? null;
  if (departmentId) {
    await assertActiveDepartment(db, actor, departmentId);
  } else {
    const def = await db.query<{ id: string }>('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [actor.companyId]);
    departmentId = def.rows[0]?.id ?? null;
  }
  if (!departmentId || !access.inScope(departmentId)) {
    throw input.departmentId ? forbidden('자신의 부서 범위 밖에는 등록할 수 없습니다.') : badRequest('관리 부서를 지정해야 합니다.');
  }

  const custom = validateCustom(input.custom ?? {}, await loadCustomDefs(db), access);
  for (const k of Object.keys(custom)) if (custom[k] === null) delete custom[k];
  const serial = input.serialNumber?.trim() || null;
  await assertUnique(db, actor, { assetTag: input.assetTag, modelId: input.modelId, serial }, null);

  const state: AssetState = input.initialState ?? 'IN_STOCK';
  const substate: AssetSubstate = state === 'IN_STOCK' ? 'AVAILABLE' : null;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO app.asset
       (company_id, model_id, asset_tag, serial_number, state, substate, department_id, location,
        purchase_date, purchase_price, supplier, warranty_end, custom, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
     RETURNING id`,
    [
      actor.companyId, input.modelId, input.assetTag, serial, state, substate, departmentId, input.location?.trim() || null,
      input.purchaseDate ?? null, input.purchasePrice ?? null, input.supplier?.trim() || null, input.warrantyEnd ?? null,
      JSON.stringify(custom), actor.userId,
    ],
  );
  const assetId = rows[0]!.id;
  await db.query(
    `INSERT INTO app.asset_txn (company_id, asset_id, type, to_state, to_substate, to_location, to_department_id, actor_id)
     VALUES ($1, $2, 'REGISTER', $3, $4, $5, $6, $7)`,
    [actor.companyId, assetId, state, substate, input.location?.trim() || null, departmentId, actor.userId],
  );
  await writeAudit(db, {
    companyId: actor.companyId,
    actorId: actor.userId,
    action: 'ASSET_CREATED',
    resource: 'asset.item',
    targetId: assetId,
    after: { assetTag: input.assetTag }, // 제한 필드 값은 감사 로그에 싣지 않는다
    ip: actor.auditIp,
  });
  await evaluateForModel(db, actor.companyId, input.modelId);
  return assetId;
}

// ─────────────────────────── 수정 ───────────────────────────

export interface UpdateAssetInput {
  modelId?: string;
  assetTag?: string;
  serialNumber?: string | null;
  departmentId?: string;
  location?: string | null;
  purchaseDate?: string | null;
  purchasePrice?: number | null;
  supplier?: string | null;
  warrantyEnd?: string | null;
  custom?: Record<string, unknown>;
}

interface LockedAsset {
  id: string;
  state: AssetState;
  substate: AssetSubstate;
  holder_person_id: string | null;
  department_id: string;
  location: string | null;
  due_date: string | null;
}

async function lockAsset(db: Db, actor: Actor, access: DataAccess, assetId: string): Promise<LockedAsset> {
  const { rows } = await db.query<LockedAsset>(SQL_ASSET_LOCK, [actor.companyId, access.scope, assetId]);
  const asset = rows[0];
  if (!asset) throw notFound();
  return asset;
}

/** 상태·보유자는 여기서 바꾸지 않는다(처리 API 전용). */
export async function updateAsset(db: Db, actor: Actor, access: DataAccess, assetId: string, input: UpdateAssetInput): Promise<void> {
  assertRestrictedWritable(access, input);
  const asset = await lockAsset(db, actor, access, assetId);
  // 바꿀 내용이 없으면 이력·감사 기록도 남기지 않는다.
  if (Object.values(input).every((v) => v === undefined)) return;
  if (asset.state === 'VOID') throw new HttpError(409, 'VOID', '등록 취소된 자산은 수정할 수 없습니다.');

  const departmentChanged = input.departmentId !== undefined && input.departmentId !== asset.department_id;
  if (departmentChanged) {
    // 범위가 제한된 사용자가 자산을 자기 범위로 끌어오거나 밖으로 내보내는 것을 막는다.
    if (!access.unrestricted) throw forbidden('관리 부서는 부서 범위 제한이 없는 사용자만 바꿀 수 있습니다.');
    await assertActiveDepartment(db, actor, input.departmentId as string);
  }
  if (input.modelId !== undefined) await assertAssetModel(db, actor, input.modelId);

  const current = await db.query<{ model_id: string; serial_number: string | null; custom: Record<string, unknown> }>(
    'SELECT model_id, serial_number, custom FROM app.asset WHERE id = $1',
    [asset.id],
  );
  const before = current.rows[0]!;
  const serial = input.serialNumber === undefined ? before.serial_number : input.serialNumber?.trim() || null;
  await assertUnique(db, actor, { assetTag: input.assetTag, modelId: input.modelId ?? before.model_id, serial }, asset.id);

  let custom = before.custom;
  if (input.custom !== undefined) {
    const patch = validateCustom(input.custom, await loadCustomDefs(db), access);
    custom = { ...before.custom };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete custom[k];
      else custom[k] = v;
    }
  }

  const location = input.location === undefined ? asset.location : input.location?.trim() || null;
  await db.query(
    `UPDATE app.asset
        SET model_id = coalesce($2, model_id),
            asset_tag = coalesce($3, asset_tag),
            serial_number = $4,
            department_id = coalesce($5, department_id),
            location = $6,
            purchase_date = CASE WHEN $7::boolean THEN $8::date ELSE purchase_date END,
            purchase_price = CASE WHEN $9::boolean THEN $10::numeric ELSE purchase_price END,
            supplier = CASE WHEN $11::boolean THEN $12 ELSE supplier END,
            warranty_end = CASE WHEN $13::boolean THEN $14::date ELSE warranty_end END,
            custom = $15,
            updated_by = $16
      WHERE id = $1`,
    [
      asset.id, input.modelId ?? null, input.assetTag ?? null, serial, departmentChanged ? input.departmentId : null, location,
      input.purchaseDate !== undefined, input.purchaseDate ?? null,
      input.purchasePrice !== undefined, input.purchasePrice ?? null,
      input.supplier !== undefined, input.supplier?.trim() || null,
      input.warrantyEnd !== undefined, input.warrantyEnd ?? null,
      JSON.stringify(custom), actor.userId,
    ],
  );

  // 모델이나 관리 부서가 바뀌면 양쪽의 사용 가능 수량이 달라진다.
  if (departmentChanged || (input.modelId !== undefined && input.modelId !== before.model_id)) {
    // 두 모델의 한계 수량을 한 번에(ID 순으로) 잠근다. 따로 잠그면 서로 반대 방향으로 바꾸는 두 요청이 교착에 빠진다.
    await evaluateForTargets(db, actor.companyId, { modelIds: [...new Set([before.model_id, input.modelId ?? before.model_id])] });
  }

  // 이력에는 "무엇이 바뀌었는지"만 남긴다. 제한 필드의 값은 남기지 않는다.
  const changed = Object.entries(input).filter(([, v]) => v !== undefined).map(([k]) => k);
  if (departmentChanged) {
    await db.query(
      `INSERT INTO app.asset_txn (company_id, asset_id, type, from_department_id, to_department_id, actor_id)
       VALUES ($1, $2, 'CHANGE_DEPARTMENT', $3, $4, $5)`,
      [actor.companyId, asset.id, asset.department_id, input.departmentId, actor.userId],
    );
  }
  await db.query(
    `INSERT INTO app.asset_txn (company_id, asset_id, type, from_location, to_location, note, actor_id)
     VALUES ($1, $2, 'UPDATE', $3, $4, $5, $6)`,
    [actor.companyId, asset.id, asset.location, location, `changed: ${changed.join(', ')}`, actor.userId],
  );
  await writeAudit(db, {
    companyId: actor.companyId,
    actorId: actor.userId,
    action: 'ASSET_UPDATED',
    resource: 'asset.item',
    targetId: asset.id,
    after: { changed },
    ip: actor.auditIp,
  });
}

// ─────────────────────────── 처리 (상태 전이) ───────────────────────────

export interface ActOnAssetInput extends ActionInput {
  note?: string | null;
  /** 처리와 함께 위치를 바꾼다(예: 배정하면서 사용자의 자리로). */
  location?: string | null;
}

export async function actOnAsset(db: Db, actor: Actor, access: DataAccess, assetId: string, action: AssetAction, input: ActOnAssetInput): Promise<{ state: AssetState; substate: AssetSubstate }> {
  const asset = await lockAsset(db, actor, access, assetId);
  let next;
  try {
    next = applyAction({ state: asset.state, substate: asset.substate, holderPersonId: asset.holder_person_id }, action, input);
  } catch (err) {
    if (err instanceof TransitionError) throw new HttpError(409, 'INVALID_TRANSITION', err.message);
    throw err;
  }
  if (action === 'VOID') {
    // 등록 취소는 잘못 등록한 자산에만 쓴다. 배정·수리 등 한 번이라도 처리된 자산은 기록을 감추지 않도록 퇴역으로 끝낸다.
    const used = await db.query(
      "SELECT 1 FROM app.asset_txn WHERE asset_id = $1 AND company_id = $2 AND type <> ALL($3::text[]) LIMIT 1",
      [asset.id, actor.companyId, ['REGISTER', 'RECEIVE', 'UPDATE', 'CHANGE_DEPARTMENT', 'IMPORT_UPDATE']],
    );
    if (used.rowCount) throw new HttpError(409, 'INVALID_TRANSITION', '이미 사용 이력이 있는 자산은 등록 취소할 수 없습니다. 퇴역으로 처리하세요.');
  }
  if ((action === 'ASSIGN' || action === 'LOAN') && next.holderPersonId) {
    // FOR SHARE: 퇴사 처리(직원 행을 FOR UPDATE 로 잠근다)와 줄을 세운다. 잠그지 않으면 "보유 자산 없음" 검사와
    // 이 배정이 서로를 보지 못해, 퇴사한 직원이 자산을 보유하게 된다.
    const person = await db.query('SELECT 1 FROM app.person WHERE id = $1 AND company_id = $2 AND is_active FOR SHARE', [next.holderPersonId, actor.companyId]);
    if (!person.rowCount) throw badRequest('선택할 수 없는 직원입니다.');
  }
  const location = input.location === undefined ? asset.location : input.location?.trim() || null;
  const dueDate = next.dueDate === undefined ? asset.due_date : next.dueDate;

  await db.query(
    `UPDATE app.asset SET state = $2, substate = $3, holder_person_id = $4, due_date = $5::date, location = $6, updated_by = $7 WHERE id = $1`,
    [asset.id, next.state, next.substate, next.holderPersonId, dueDate, location, actor.userId],
  );
  await db.query(
    `INSERT INTO app.asset_txn
       (company_id, asset_id, type, from_state, to_state, from_substate, to_substate,
        from_holder_id, to_holder_id, from_location, to_location, note, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      actor.companyId, asset.id, action, asset.state, next.state, asset.substate, next.substate,
      asset.holder_person_id, next.holderPersonId, asset.location, location, input.note?.trim() || null, actor.userId,
    ],
  );
  // 사용 가능 수량이 바뀌었을 수 있다. 한계 수량을 다시 본다.
  const model = await db.query<{ model_id: string }>('SELECT model_id FROM app.asset WHERE id = $1 AND company_id = $2', [asset.id, actor.companyId]);
  await evaluateForModel(db, actor.companyId, model.rows[0]!.model_id);
  return { state: next.state, substate: next.substate };
}
