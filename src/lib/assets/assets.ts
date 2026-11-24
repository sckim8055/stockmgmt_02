// 자산(한 행이 실물 한 대). 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 이 파일의 모든 조회·변경은 두 가지를 반드시 거친다.
//   1) 부서 범위: access.scope 를 SQL 조건에 넣는다. 범위 밖 자산은 "없는 것"으로 응답한다(404).
//   2) 제한 필드: 읽기 권한이 없는 필드는 응답에서 빼고(present), 정렬·검색에도 쓸 수 없게 한다.
import type { Db } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import type { DataAccess } from '@/lib/authz/scope';
import { HttpError, badRequest, forbidden, notFound } from '@/lib/http/errors';
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

const SQL_ASSET_FILTERS =
  ' AND ($3::text IS NULL OR a.state = $3)' +
  ' AND ($4::text IS NULL OR a.substate = $4)' +
  ' AND ($5::uuid IS NULL OR a.model_id = $5)' +
  ' AND ($6::uuid IS NULL OR m.category_id = $6)' +
  ' AND ($7::uuid IS NULL OR a.department_id = $7)' +
  ' AND ($8::uuid IS NULL OR a.holder_person_id = $8)' +
  // 검색 대상에 제한 필드(공급업체 등)는 넣지 않는다. 검색 결과로 값을 추정할 수 있기 때문이다.
  ' AND ($9::text IS NULL OR a.asset_tag ILIKE $9 OR a.serial_number ILIKE $9 OR a.location ILIKE $9' +
  '      OR m.name ILIKE $9 OR m.manufacturer ILIKE $9 OR p.name ILIKE $9)' +
  // $10 = 목록에서 뺄 상태들. 등록 취소(VOID)된 자산은 따로 요청할 때만 보인다.
  ' AND a.state <> ALL($10::text[]) ';

const SQL_ASSET_LIST_BASE = 'SELECT' + SQL_ASSET_COLUMNS + SQL_ASSET_FROM + 'WHERE' + SQL_ASSET_VISIBLE + SQL_ASSET_FILTERS;
const SQL_ASSET_PAGE = ', a.id LIMIT $11 OFFSET $12';
const SQL_ASSET_COUNT = 'SELECT count(*)::int AS n' + SQL_ASSET_FROM + 'WHERE' + SQL_ASSET_VISIBLE + SQL_ASSET_FILTERS;

// 정렬은 이 목록에 있는 것만 허용한다. 입력값이 SQL 에 들어가지 않는다.
const SQL_ASSET_LIST_BY: Record<string, string> = {
  'asset_tag:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(a.asset_tag) ASC' + SQL_ASSET_PAGE,
  'asset_tag:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(a.asset_tag) DESC' + SQL_ASSET_PAGE,
  'state:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.state ASC, a.substate ASC NULLS FIRST' + SQL_ASSET_PAGE,
  'state:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.state DESC, a.substate DESC NULLS LAST' + SQL_ASSET_PAGE,
  'model:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(m.manufacturer) ASC, lower(m.name) ASC' + SQL_ASSET_PAGE,
  'model:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(m.manufacturer) DESC, lower(m.name) DESC' + SQL_ASSET_PAGE,
  'department:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(d.name) ASC' + SQL_ASSET_PAGE,
  'department:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(d.name) DESC' + SQL_ASSET_PAGE,
  'holder:asc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(p.name) ASC NULLS LAST' + SQL_ASSET_PAGE,
  'holder:desc': SQL_ASSET_LIST_BASE + ' ORDER BY lower(p.name) DESC NULLS LAST' + SQL_ASSET_PAGE,
  'warranty_end:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.warranty_end ASC NULLS LAST' + SQL_ASSET_PAGE,
  'warranty_end:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.warranty_end DESC NULLS LAST' + SQL_ASSET_PAGE,
  'purchase_date:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.purchase_date ASC NULLS LAST' + SQL_ASSET_PAGE,
  'purchase_date:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.purchase_date DESC NULLS LAST' + SQL_ASSET_PAGE,
  'updated_at:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.updated_at ASC' + SQL_ASSET_PAGE,
  'updated_at:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.updated_at DESC' + SQL_ASSET_PAGE,
  // 제한 필드로 정렬하려면 그 필드의 읽기 권한이 있어야 한다(listAssets 에서 검사).
  'purchase_price:asc': SQL_ASSET_LIST_BASE + ' ORDER BY a.purchase_price ASC NULLS LAST' + SQL_ASSET_PAGE,
  'purchase_price:desc': SQL_ASSET_LIST_BASE + ' ORDER BY a.purchase_price DESC NULLS LAST' + SQL_ASSET_PAGE,
};
export const ASSET_SORT_KEYS = [
  'asset_tag', 'state', 'model', 'department', 'holder', 'warranty_end', 'purchase_date', 'updated_at', 'purchase_price',
] as const;
export type AssetSortKey = (typeof ASSET_SORT_KEYS)[number];

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
  includeVoid?: boolean;
  sort?: AssetSortKey;
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/** LIKE 패턴 문자를 글자 그대로 검색하도록 이스케이프한다. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

export async function listAssets(db: Db, actor: Actor, access: DataAccess, query: AssetListQuery): Promise<{ total: number; page: number; pageSize: number; items: AssetRow[] }> {
  const sort = query.sort ?? 'asset_tag';
  if (sort === 'purchase_price' && !access.canReadField('purchase_price')) {
    throw forbidden('구매가로 정렬할 권한이 없습니다.');
  }
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const q = query.q?.trim();
  const filters = [
    actor.companyId,
    access.scope,
    query.state ?? null,
    query.substate ?? null,
    query.modelId ?? null,
    query.categoryId ?? null,
    query.departmentId ?? null,
    query.holderPersonId ?? null,
    q ? likePattern(q) : null,
    query.includeVoid ? [] : ['VOID'],
  ];
  const sortKey = `${sort}:${query.order ?? 'asc'}`;
  if (!Object.hasOwn(SQL_ASSET_LIST_BY, sortKey)) throw badRequest('정렬 기준이 올바르지 않습니다.');

  const [count, rows, defs] = [
    await db.query<{ n: number }>(SQL_ASSET_COUNT, filters),
    await db.query<AssetRow>(SQL_ASSET_LIST_BY[sortKey] as string, [...filters, pageSize, (page - 1) * pageSize]),
    await loadCustomDefs(db),
  ];
  return { total: count.rows[0]?.n ?? 0, page, pageSize, items: rows.rows.map((r) => present(r, access, defs)) };
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
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 500`,
    [assetId, actor.companyId],
  );
  return rows;
}

// ─────────────────────────── 입력 검증 ───────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 사용자 지정 필드 입력을 검증한다. 정의에 없는 키, 형식이 맞지 않는 값, 권한 없는 제한 필드는 거부한다.
 * 값이 null 이면 그 키를 지운다는 뜻이다.
 */
function validateCustom(input: Record<string, unknown>, defs: CustomDef[], access: DataAccess): Record<string, unknown> {
  const known = new Map(defs.map((d) => [d.key, d]));
  const out: Record<string, unknown> = {};
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
      (def.data_type === 'text' && typeof value === 'string' && value.length <= 500) ||
      (def.data_type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (def.data_type === 'date' && typeof value === 'string' && DATE_RE.test(value)) ||
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

async function assertUnique(db: Db, actor: Actor, v: { assetTag?: string; modelId?: string; serial?: string | null }, exceptId: string | null): Promise<void> {
  if (v.assetTag !== undefined) {
    const r = await db.query('SELECT 1 FROM app.asset WHERE company_id = $1 AND lower(asset_tag) = lower($2) AND ($3::uuid IS NULL OR id <> $3)', [
      actor.companyId,
      v.assetTag,
      exceptId,
    ]);
    // 범위 밖 자산과 겹쳐도 같은 메시지다. 자산 태그는 기업 전체에서 고유해야 하므로 존재 사실 자체는 알려줄 수밖에 없다.
    if (r.rowCount) throw new HttpError(409, 'DUPLICATE', '이미 사용 중인(또는 과거에 사용한) 자산 태그입니다.');
  }
  if (v.serial && v.modelId) {
    const r = await db.query(
      'SELECT 1 FROM app.asset WHERE company_id = $1 AND model_id = $2 AND lower(serial_number) = lower($3) AND ($4::uuid IS NULL OR id <> $4)',
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
  return { state: next.state, substate: next.substate };
}
