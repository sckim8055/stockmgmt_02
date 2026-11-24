// 모델. 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 규칙
//  - 모델의 종류(kind)는 항상 카테고리에서 복사한다. 입력으로 받지 않는다.
//    (DB도 (category_id, company_id, kind) 복합 외래키로 강제한다)
//  - (제조사, 이름)은 기업 안에서 고유하다(대소문자 무시).
//  - 카테고리는 같은 종류의 활성 카테고리로만 바꿀 수 있다.
//  - 자산·주변기기 재고·한계수량이 참조하는 모델은 삭제할 수 없다. 비활성화한다.
import type { Db } from '@/lib/db/context';
import { evaluateForTargets } from '@/lib/alerts/thresholds';
import { writeAudit } from '@/lib/auth/audit';
import { badRequest, notFound } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import type { ItemKind } from './categories';
import { conflict, likePattern, lockMasterData, mapDbError } from './common';

const RESOURCE = 'master.model';

export interface ModelRow {
  id: string;
  category_id: string;
  category_name: string;
  category_is_active: boolean;
  kind: ItemKind;
  manufacturer: string;
  name: string;
  is_active: boolean;
}

const SQL_MODEL_LIST =
  'SELECT m.id, m.category_id, c.name AS category_name, c.is_active AS category_is_active, m.kind, m.manufacturer, m.name, m.is_active' +
  ' FROM app.item_model m JOIN app.category c ON c.id = m.category_id AND c.company_id = m.company_id' +
  ' WHERE m.company_id = $1' +
  ' AND ($2::text IS NULL OR m.kind = $2)' +
  ' AND ($3::uuid IS NULL OR m.category_id = $3)' +
  ' AND ($4::text IS NULL OR m.manufacturer ILIKE $4 OR m.name ILIKE $4)' +
  ' AND ($5::boolean OR m.is_active)' +
  ' ORDER BY lower(m.manufacturer), lower(m.name), m.id' +
  ' LIMIT 1000';

export interface ModelListQuery {
  kind?: ItemKind;
  categoryId?: string;
  q?: string;
  includeInactive?: boolean;
}

export async function listModels(db: Db, actor: Actor, query: ModelListQuery): Promise<ModelRow[]> {
  const q = query.q?.trim();
  const { rows } = await db.query<ModelRow>(SQL_MODEL_LIST, [
    actor.companyId, query.kind ?? null, query.categoryId ?? null, q ? likePattern(q) : null, query.includeInactive ?? false,
  ]);
  return rows;
}

interface LockedModel {
  id: string;
  category_id: string;
  kind: ItemKind;
  manufacturer: string;
  name: string;
  is_active: boolean;
}

async function lockModel(db: Db, actor: Actor, modelId: string): Promise<LockedModel> {
  await lockMasterData(db, actor.companyId);
  const { rows } = await db.query<LockedModel>(
    'SELECT id, category_id, kind, manufacturer, name, is_active FROM app.item_model WHERE id = $1 AND company_id = $2 FOR UPDATE',
    [modelId, actor.companyId],
  );
  const model = rows[0];
  if (!model) throw notFound();
  return model;
}

/**
 * 고를 수 있는 카테고리인지 확인하고 종류를 돌려준다. 다른 기업의 카테고리는 "없는 것"이다.
 * FOR SHARE: 확인과 저장 사이에 카테고리가 비활성화되거나 종류가 바뀌지 않게 한다.
 */
async function categoryKind(db: Db, actor: Actor, categoryId: string): Promise<ItemKind> {
  const { rows } = await db.query<{ kind: ItemKind }>(
    'SELECT kind FROM app.category WHERE id = $1 AND company_id = $2 AND is_active FOR SHARE',
    [categoryId, actor.companyId],
  );
  const row = rows[0];
  if (!row) throw badRequest('선택할 수 없는 카테고리입니다.');
  return row.kind;
}

async function assertNameFree(db: Db, actor: Actor, manufacturer: string, name: string, exceptId: string | null): Promise<void> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM app.item_model WHERE company_id = $1 AND lower(manufacturer) = lower($2) AND lower(name) = lower($3) AND ($4::uuid IS NULL OR id <> $4)',
    [actor.companyId, manufacturer, name, exceptId],
  );
  if (rowCount) throw conflict('DUPLICATE', '같은 제조사·이름의 모델이 이미 있습니다.');
}

export interface ModelInput {
  categoryId: string;
  manufacturer: string;
  name: string;
}

export async function createModel(db: Db, actor: Actor, input: ModelInput): Promise<string> {
  await lockMasterData(db, actor.companyId);
  const kind = await categoryKind(db, actor, input.categoryId);
  await assertNameFree(db, actor, input.manufacturer, input.name, null);
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [actor.companyId, input.categoryId, kind, input.manufacturer, input.name],
  );
  const id = rows[0]!.id;
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'MODEL_CREATED', resource: RESOURCE, targetId: id,
    after: { categoryId: input.categoryId, kind, manufacturer: input.manufacturer, name: input.name }, ip: actor.auditIp,
  });
  return id;
}

export async function updateModel(db: Db, actor: Actor, modelId: string, input: Partial<ModelInput>): Promise<void> {
  const model = await lockModel(db, actor, modelId);
  if (Object.values(input).every((v) => v === undefined)) return;
  const categoryChanged = input.categoryId !== undefined && input.categoryId !== model.category_id;
  if (categoryChanged) {
    const kind = await categoryKind(db, actor, input.categoryId as string);
    // 종류가 다른 카테고리로 옮기면 이 모델을 쓰는 자산·재고의 종류 규칙이 깨진다.
    if (kind !== model.kind) throw badRequest('종류가 다른 카테고리로는 옮길 수 없습니다.');
  }
  const manufacturer = input.manufacturer ?? model.manufacturer;
  const name = input.name ?? model.name;
  if (input.manufacturer !== undefined || input.name !== undefined) await assertNameFree(db, actor, manufacturer, name, model.id);
  await db.query(
    'UPDATE app.item_model SET category_id = $2, manufacturer = $3, name = $4 WHERE id = $1 AND company_id = $5',
    [model.id, categoryChanged ? input.categoryId : model.category_id, manufacturer, name, actor.companyId],
  );
  // 모델이 다른 카테고리로 가면 두 카테고리의 사용 가능 수량이 달라진다.
  if (categoryChanged) await evaluateForTargets(db, actor.companyId, { categoryIds: [model.category_id, input.categoryId as string] });
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'MODEL_UPDATED', resource: RESOURCE, targetId: model.id,
    before: { categoryId: model.category_id, manufacturer: model.manufacturer, name: model.name },
    after: { categoryId: input.categoryId, manufacturer: input.manufacturer, name: input.name },
    ip: actor.auditIp,
  });
}

export async function setModelActive(db: Db, actor: Actor, modelId: string, active: boolean): Promise<void> {
  const model = await lockModel(db, actor, modelId);
  if (model.is_active === active) return;
  await db.query('UPDATE app.item_model SET is_active = $2 WHERE id = $1 AND company_id = $3', [model.id, active, actor.companyId]);
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: active ? 'MODEL_ACTIVATED' : 'MODEL_DEACTIVATED',
    resource: RESOURCE, targetId: model.id, before: { manufacturer: model.manufacturer, name: model.name }, ip: actor.auditIp,
  });
}

const SQL_MODEL_IN_USE =
  'SELECT EXISTS (SELECT 1 FROM app.asset WHERE model_id = $1 AND company_id = $2)' +
  ' OR EXISTS (SELECT 1 FROM app.peripheral_stock WHERE model_id = $1 AND company_id = $2)' +
  ' OR EXISTS (SELECT 1 FROM app.stock_threshold WHERE model_id = $1 AND company_id = $2) AS used';

export async function deleteModel(db: Db, actor: Actor, modelId: string): Promise<void> {
  const model = await lockModel(db, actor, modelId);
  const inUse = () => conflict('IN_USE', '자산·재고·한계수량에서 쓰는 모델은 삭제할 수 없습니다. 대신 비활성화하세요.');
  if ((await db.query<{ used: boolean }>(SQL_MODEL_IN_USE, [model.id, actor.companyId])).rows[0]!.used) throw inUse();
  await mapDbError(db.query('DELETE FROM app.item_model WHERE id = $1 AND company_id = $2', [model.id, actor.companyId]), { '23503': inUse });
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'MODEL_DELETED', resource: RESOURCE, targetId: model.id,
    before: { categoryId: model.category_id, manufacturer: model.manufacturer, name: model.name }, ip: actor.auditIp,
  });
}
