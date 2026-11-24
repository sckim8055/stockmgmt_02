// 한계 수량. 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 규칙
//  - 대상은 카테고리 또는 모델 하나, 범위는 기업 전체 또는 관리 부서 하나.
//  - "사용 가능 수량" = 자산은 재고·사용 가능 상태의 대수, 주변기기는 보유 수량의 합.
//  - 수량이 한계 수량 미만이 되면 부족(LOW), 한계 수량 × 여유 비율 이상으로 돌아오면 정상(OK).
//    상태가 바뀔 때만 알림을 만든다(경계에서 오르내릴 때 알림이 쏟아지지 않게 여유 비율을 둔다).
//  - 재고를 바꾸는 모든 처리가 끝에 evaluateForModel(s)() 을 부른다. 한계 수량 행을 잠근 뒤에 수량을 세므로,
//    동시에 일어난 두 처리 중 나중 것이 앞의 것까지 반영된 수량을 본다.
//  - 잠금 순서: 재고(자산·재고 행)를 모두 바꾼 뒤, 마지막에, 관련된 한계 수량 전부를 ID 순으로 한 번에 잠근다.
//    한 트랜잭션에서 한계 수량을 잠근 뒤에 다른 재고 행을 잠그지 않는다(교착 방지). 여러 행을 처리하는 엑셀 업로드는
//    deferEvaluation() 으로 판정을 미뤘다가 끝에 한 번만 한다(잠금을 업로드 내내 잡고 있지 않도록).
//  - 부서 범위가 제한된 사용자는 자기 범위의 부서에 대한 한계 수량만 보고 관리한다. 기업 전체 한계 수량은 범위 제한이 없는 사용자만.
import type { Db } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import type { DataAccess } from '@/lib/authz/scope';
import { badRequest, forbidden, HttpError, notFound } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { notify } from './notify';

const RESOURCE = 'threshold';
const conflict = (code: string, message: string) => new HttpError(409, code, message);

// 한계 수량 t 의 현재 사용 가능 수량.
const SQL_THRESHOLD_QTY =
  '(SELECT count(*)::int FROM app.asset a JOIN app.item_model m ON m.id = a.model_id AND m.company_id = a.company_id' +
  "   WHERE a.company_id = t.company_id AND a.state = 'IN_STOCK' AND a.substate = 'AVAILABLE'" +
  '     AND (a.model_id = t.model_id OR m.category_id = t.category_id)' +
  '     AND (t.department_id IS NULL OR a.department_id = t.department_id))' +
  ' + (SELECT coalesce(sum(s.on_hand_qty), 0)::int FROM app.peripheral_stock s JOIN app.item_model m ON m.id = s.model_id AND m.company_id = s.company_id' +
  '   WHERE s.company_id = t.company_id' +
  '     AND (s.model_id = t.model_id OR m.category_id = t.category_id)' +
  '     AND (t.department_id IS NULL OR s.department_id = t.department_id))';

const SQL_THRESHOLD_TARGET =
  ' coalesce(c.name, m.manufacturer || chr(32) || m.name) AS target_name, coalesce(c.kind, m.kind) AS kind, d.name AS department_name';
const SQL_THRESHOLD_JOINS =
  ' LEFT JOIN app.category c ON c.id = t.category_id AND c.company_id = t.company_id' +
  ' LEFT JOIN app.item_model m ON m.id = t.model_id AND m.company_id = t.company_id' +
  ' LEFT JOIN app.department d ON d.id = t.department_id AND d.company_id = t.company_id';

interface EvalRow {
  id: string;
  department_id: string | null;
  min_qty: number;
  /** 회복 기준 = ceil(한계 수량 × 여유 비율). DB 의 정확한 소수 계산으로 구한다(부동소수점 오차로 하나 커지지 않게). */
  recover_at: number;
  state: 'OK' | 'LOW';
  qty: number;
  target_name: string;
  department_name: string | null;
}

// 잠금(FOR UPDATE OF t)을 얻은 뒤에 읽기 시작한 쿼리로 수량을 세야 하므로, 잠그는 쿼리와 세는 쿼리를 나눈다.
// $2 모델들, $3 카테고리들. 모델에 직접 걸린 것, 그 모델의 카테고리에 걸린 것, 지정한 카테고리에 걸린 것.
const SQL_THRESHOLD_LOCK_FOR_TARGETS =
  'SELECT t.id FROM app.stock_threshold t WHERE t.company_id = $1 AND t.is_active' +
  ' AND (t.model_id = ANY($2::uuid[]) OR t.category_id = ANY($3::uuid[])' +
  '      OR t.category_id IN (SELECT m.category_id FROM app.item_model m WHERE m.id = ANY($2::uuid[]) AND m.company_id = $1))' +
  ' ORDER BY t.id FOR UPDATE OF t';
const SQL_THRESHOLD_EVAL =
  'SELECT t.id, t.department_id, t.min_qty, ceil(t.min_qty * t.warn_ratio)::int AS recover_at, t.state, ' + SQL_THRESHOLD_QTY + ' AS qty,' + SQL_THRESHOLD_TARGET +
  ' FROM app.stock_threshold t' + SQL_THRESHOLD_JOINS + ' WHERE t.company_id = $1 AND t.id = ANY($2::uuid[]) ORDER BY t.id';

async function evaluate(db: Db, companyId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { rows } = await db.query<EvalRow>(SQL_THRESHOLD_EVAL, [companyId, ids]);
  for (const t of rows) {
    const next = t.state === 'OK' ? (t.qty < t.min_qty ? 'LOW' : 'OK') : t.qty >= t.recover_at ? 'OK' : 'LOW';
    if (next === t.state) continue;
    await db.query(
      "UPDATE app.stock_threshold SET state = $2, last_alert_at = CASE WHEN $2 = 'LOW' THEN now() ELSE last_alert_at END WHERE id = $1 AND company_id = $3",
      [t.id, next, companyId],
    );
    await notify(db, companyId, t.department_id, next === 'LOW' ? 'LOW_STOCK' : 'STOCK_RECOVERED', {
      thresholdId: t.id, target: t.target_name, department: t.department_name, qty: t.qty, minQty: t.min_qty,
    });
  }
}

/** 판정을 미루는 중인 트랜잭션과, 그동안 바뀐 모델들. */
const deferred = new WeakMap<Db, Set<string>>();

/** 이 트랜잭션의 판정을 flushEvaluation() 까지 미룬다(여러 행을 처리하는 엑셀 업로드용). */
export function deferEvaluation(db: Db): void {
  if (!deferred.has(db)) deferred.set(db, new Set());
}

/** 미뤄 둔 판정을 한 번에 한다. 트랜잭션에서 재고를 다 바꾼 뒤, 맨 끝에 부른다. */
export async function flushEvaluation(db: Db, companyId: string): Promise<void> {
  const models = deferred.get(db);
  deferred.delete(db);
  if (models?.size) await evaluateForTargets(db, companyId, { modelIds: [...models] });
}

/**
 * 이 모델들(과 그 카테고리들), 카테고리들에 걸린 한계 수량을 다시 계산한다. 재고를 바꾼 처리의 맨 끝에서, 한 번만 부른다.
 * 관련된 한계 수량을 ID 순으로 한 번에 잠근다.
 */
export async function evaluateForTargets(db: Db, companyId: string, targets: { modelIds?: string[]; categoryIds?: string[] }): Promise<void> {
  const pending = deferred.get(db);
  if (pending && !targets.categoryIds?.length) {
    for (const id of targets.modelIds ?? []) pending.add(id);
    return;
  }
  const locked = await db.query<{ id: string }>(SQL_THRESHOLD_LOCK_FOR_TARGETS, [companyId, targets.modelIds ?? [], targets.categoryIds ?? []]);
  await evaluate(db, companyId, locked.rows.map((r) => r.id));
}

export const evaluateForModel = (db: Db, companyId: string, modelId: string): Promise<void> => evaluateForTargets(db, companyId, { modelIds: [modelId] });

// ─────────────────────────── 조회·관리 ───────────────────────────

// $1 기업, $2 부서 범위(NULL = 전체). 범위가 제한된 사용자는 자기 부서의 한계 수량만 본다(기업 전체 것은 보지 못한다).
const SQL_THRESHOLD_VISIBLE = ' t.company_id = $1 AND ($2::uuid[] IS NULL OR t.department_id = ANY($2)) ';
const SQL_THRESHOLD_LIST =
  'SELECT t.id, t.category_id, t.model_id, t.department_id, t.min_qty, t.warn_ratio::float8 AS warn_ratio, ceil(t.min_qty * t.warn_ratio)::int AS recover_at, t.state, t.is_active, t.last_alert_at, ' +
  SQL_THRESHOLD_QTY + ' AS qty,' + SQL_THRESHOLD_TARGET +
  ' FROM app.stock_threshold t' + SQL_THRESHOLD_JOINS + ' WHERE' + SQL_THRESHOLD_VISIBLE +
  // 사용 중인 것 먼저, 그 안에서 부족(LOW)한 것 먼저.
  ' ORDER BY (NOT t.is_active), t.state, lower(coalesce(c.name, m.manufacturer || chr(32) || m.name)), d.name NULLS FIRST, t.id';
const SQL_THRESHOLD_LOCK_ONE = 'SELECT t.id, t.category_id, t.model_id, t.department_id, t.min_qty, t.warn_ratio::float8 AS warn_ratio, t.is_active FROM app.stock_threshold t WHERE t.id = $3 AND' + SQL_THRESHOLD_VISIBLE + 'FOR UPDATE';

export async function listThresholds(db: Db, actor: Actor, access: DataAccess): Promise<unknown[]> {
  return (await db.query(SQL_THRESHOLD_LIST, [actor.companyId, access.scope])).rows;
}

export interface ThresholdInput {
  categoryId?: string | null;
  modelId?: string | null;
  departmentId?: string | null;
  minQty: number;
  warnRatio?: number;
}

async function assertDepartment(db: Db, actor: Actor, access: DataAccess, departmentId: string | null): Promise<void> {
  if (departmentId === null) {
    if (!access.unrestricted) throw forbidden('기업 전체에 대한 한계 수량은 부서 범위 제한이 없는 사용자만 만들 수 있습니다.');
    return;
  }
  if (!access.inScope(departmentId)) throw forbidden('자신의 부서 범위 밖입니다.');
  const { rowCount } = await db.query('SELECT 1 FROM app.department WHERE id = $1 AND company_id = $2 AND is_active FOR SHARE', [departmentId, actor.companyId]);
  if (!rowCount) throw badRequest('선택할 수 없는 부서입니다.');
}

export async function createThreshold(db: Db, actor: Actor, access: DataAccess, input: ThresholdInput): Promise<string> {
  const categoryId = input.categoryId ?? null;
  const modelId = input.modelId ?? null;
  const departmentId = input.departmentId ?? null;
  if ((categoryId === null) === (modelId === null)) throw badRequest('카테고리와 모델 중 하나만 지정해야 합니다.');
  await assertDepartment(db, actor, access, departmentId);
  const target = categoryId
    ? await db.query('SELECT 1 FROM app.category WHERE id = $1 AND company_id = $2 AND is_active FOR SHARE', [categoryId, actor.companyId])
    : await db.query('SELECT 1 FROM app.item_model WHERE id = $1 AND company_id = $2 AND is_active FOR SHARE', [modelId, actor.companyId]);
  if (!target.rowCount) throw badRequest('선택할 수 없는 대상입니다.');
  // 같은 대상·같은 부서의 한계 수량은 하나만. 고유 인덱스가 최종 안전망이다(route() 가 409 로 바꾼다).
  const dup = await db.query(
    'SELECT 1 FROM app.stock_threshold WHERE company_id = $1 AND coalesce(category_id, model_id) = $2 AND department_id IS NOT DISTINCT FROM $3',
    [actor.companyId, categoryId ?? modelId, departmentId],
  );
  if (dup.rowCount) throw conflict('DUPLICATE', '같은 대상·같은 부서의 한계 수량이 이미 있습니다.');
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO app.stock_threshold (company_id, category_id, model_id, department_id, min_qty, warn_ratio) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [actor.companyId, categoryId, modelId, departmentId, input.minQty, input.warnRatio ?? 1],
  );
  const id = rows[0]!.id;
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'THRESHOLD_CREATED', resource: RESOURCE, targetId: id,
    after: { categoryId, modelId, departmentId, minQty: input.minQty, warnRatio: input.warnRatio ?? 1 }, ip: actor.auditIp,
  });
  // 만들 때 이미 부족하면 바로 알린다.
  await evaluate(db, actor.companyId, [id]);
  return id;
}

interface LockedThreshold {
  id: string;
  min_qty: number;
  warn_ratio: number;
  is_active: boolean;
}

async function lockThreshold(db: Db, actor: Actor, access: DataAccess, id: string): Promise<LockedThreshold> {
  const { rows } = await db.query<LockedThreshold>(SQL_THRESHOLD_LOCK_ONE, [actor.companyId, access.scope, id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

/** 수량·여유 비율·사용 여부만 바꾼다. 대상과 부서는 바꿀 수 없다(지우고 다시 만든다). */
export async function updateThreshold(db: Db, actor: Actor, access: DataAccess, id: string, input: { minQty?: number; warnRatio?: number; isActive?: boolean }): Promise<void> {
  const t = await lockThreshold(db, actor, access, id);
  if (Object.values(input).every((v) => v === undefined)) return;
  // 꺼 둔 동안의 변화는 알리지 않는다. 다시 켜면 정상 상태에서 새로 판정한다.
  await db.query(
    "UPDATE app.stock_threshold SET min_qty = coalesce($2, min_qty), warn_ratio = coalesce($3, warn_ratio), is_active = coalesce($4, is_active), state = CASE WHEN $4::boolean IS NOT DISTINCT FROM false OR ($4::boolean IS TRUE AND NOT is_active) THEN 'OK' ELSE state END WHERE id = $1 AND company_id = $5",
    [t.id, input.minQty ?? null, input.warnRatio ?? null, input.isActive ?? null, actor.companyId],
  );
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'THRESHOLD_UPDATED', resource: RESOURCE, targetId: t.id,
    before: { minQty: t.min_qty, warnRatio: t.warn_ratio, isActive: t.is_active }, after: input, ip: actor.auditIp,
  });
  if (input.isActive ?? t.is_active) await evaluate(db, actor.companyId, [t.id]);
}

export async function deleteThreshold(db: Db, actor: Actor, access: DataAccess, id: string): Promise<void> {
  const t = await lockThreshold(db, actor, access, id);
  await db.query('DELETE FROM app.stock_threshold WHERE id = $1 AND company_id = $2', [t.id, actor.companyId]);
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'THRESHOLD_DELETED', resource: RESOURCE, targetId: t.id,
    before: { minQty: t.min_qty, warnRatio: t.warn_ratio }, ip: actor.auditIp,
  });
}
