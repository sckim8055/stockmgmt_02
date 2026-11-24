// 카테고리. 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 규칙
//  - 이름은 기업 안에서 고유하다(대소문자 무시, 종류와 무관).
//  - 종류(kind)는 그 카테고리에 모델이 하나라도 있으면 바꿀 수 없다(모델의 kind 가 카테고리를 따라가야 하므로).
//  - 모델·한계수량이 참조하는 카테고리는 삭제할 수 없다. 비활성화한다.
import type { Db } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import { notFound } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { conflict, lockMasterData, mapDbError } from './common';

const RESOURCE = 'master.category';

export type ItemKind = 'ASSET' | 'PERIPHERAL';

export interface CategoryRow {
  id: string;
  kind: ItemKind;
  name: string;
  name_ko: string | null;
  name_zh: string | null;
  sort_order: number;
  is_active: boolean;
  model_count: number;
}

const SQL_CATEGORY_LIST =
  'SELECT c.id, c.kind, c.name, c.name_ko, c.name_zh, c.sort_order, c.is_active,' +
  ' (SELECT count(*)::int FROM app.item_model m WHERE m.category_id = c.id AND m.company_id = c.company_id) AS model_count' +
  ' FROM app.category c' +
  ' WHERE c.company_id = $1 AND ($2::text IS NULL OR c.kind = $2) AND ($3::boolean OR c.is_active)' +
  ' ORDER BY c.kind, c.sort_order, lower(c.name), c.id';

export async function listCategories(db: Db, actor: Actor, query: { kind?: ItemKind; includeInactive?: boolean }): Promise<CategoryRow[]> {
  const { rows } = await db.query<CategoryRow>(SQL_CATEGORY_LIST, [actor.companyId, query.kind ?? null, query.includeInactive ?? false]);
  return rows;
}

interface LockedCategory {
  id: string;
  kind: ItemKind;
  name: string;
  is_active: boolean;
}

/** 자기 기업의 카테고리를 잠그고 읽는다. 다른 기업의 것은 없는 것으로 응답한다. */
async function lockCategory(db: Db, actor: Actor, categoryId: string): Promise<LockedCategory> {
  await lockMasterData(db, actor.companyId);
  const { rows } = await db.query<LockedCategory>(
    'SELECT id, kind, name, is_active FROM app.category WHERE id = $1 AND company_id = $2 FOR UPDATE',
    [categoryId, actor.companyId],
  );
  const cat = rows[0];
  if (!cat) throw notFound();
  return cat;
}

async function assertNameFree(db: Db, actor: Actor, name: string, exceptId: string | null): Promise<void> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM app.category WHERE company_id = $1 AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3)',
    [actor.companyId, name, exceptId],
  );
  if (rowCount) throw conflict('DUPLICATE', '같은 이름의 카테고리가 이미 있습니다.');
}

const modelCount = async (db: Db, actor: Actor, categoryId: string): Promise<number> =>
  (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.item_model WHERE category_id = $1 AND company_id = $2', [categoryId, actor.companyId]))
    .rows[0]!.n;

export interface CategoryInput {
  kind: ItemKind;
  name: string;
  nameKo?: string | null;
  nameZh?: string | null;
  sortOrder?: number;
}

export async function createCategory(db: Db, actor: Actor, input: CategoryInput): Promise<string> {
  await lockMasterData(db, actor.companyId);
  await assertNameFree(db, actor, input.name, null);
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO app.category (company_id, kind, name, name_ko, name_zh, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [actor.companyId, input.kind, input.name, input.nameKo || null, input.nameZh || null, input.sortOrder ?? 0],
  );
  const id = rows[0]!.id;
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'CATEGORY_CREATED', resource: RESOURCE, targetId: id,
    after: { kind: input.kind, name: input.name }, ip: actor.auditIp,
  });
  return id;
}

export async function updateCategory(db: Db, actor: Actor, categoryId: string, input: Partial<CategoryInput>): Promise<void> {
  const cat = await lockCategory(db, actor, categoryId);
  if (Object.values(input).every((v) => v === undefined)) return;
  if (input.name !== undefined) await assertNameFree(db, actor, input.name, cat.id);
  const kindChanged = input.kind !== undefined && input.kind !== cat.kind;
  const kindLocked = () => conflict('KIND_LOCKED', '모델이 등록된 카테고리는 종류를 바꿀 수 없습니다.');
  if (kindChanged && (await modelCount(db, actor, cat.id)) > 0) throw kindLocked();
  await mapDbError(
    db.query(
      `UPDATE app.category
          SET kind = coalesce($2, kind),
              name = coalesce($3, name),
              name_ko = CASE WHEN $4::boolean THEN $5 ELSE name_ko END,
              name_zh = CASE WHEN $6::boolean THEN $7 ELSE name_zh END,
              sort_order = coalesce($8, sort_order)
        WHERE id = $1 AND company_id = $9`,
      [
        cat.id, input.kind ?? null, input.name ?? null,
        input.nameKo !== undefined, input.nameKo || null,
        input.nameZh !== undefined, input.nameZh || null,
        input.sortOrder ?? null, actor.companyId,
      ],
    ),
    { '23503': kindLocked }, // 모델이 (id, company_id, kind) 로 참조하고 있는 경우의 마지막 방어선
  );
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'CATEGORY_UPDATED', resource: RESOURCE, targetId: cat.id,
    before: { kind: cat.kind, name: cat.name },
    after: { changed: Object.entries(input).filter(([, v]) => v !== undefined).map(([k]) => k), kind: input.kind, name: input.name },
    ip: actor.auditIp,
  });
}

export async function setCategoryActive(db: Db, actor: Actor, categoryId: string, active: boolean): Promise<void> {
  const cat = await lockCategory(db, actor, categoryId);
  if (cat.is_active === active) return;
  await db.query('UPDATE app.category SET is_active = $2 WHERE id = $1 AND company_id = $3', [cat.id, active, actor.companyId]);
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: active ? 'CATEGORY_ACTIVATED' : 'CATEGORY_DEACTIVATED',
    resource: RESOURCE, targetId: cat.id, before: { name: cat.name }, ip: actor.auditIp,
  });
}

export async function deleteCategory(db: Db, actor: Actor, categoryId: string): Promise<void> {
  const cat = await lockCategory(db, actor, categoryId);
  const inUse = () => conflict('IN_USE', '모델이나 한계수량 설정이 있는 카테고리는 삭제할 수 없습니다. 대신 비활성화하세요.');
  const thresholds = await db.query('SELECT 1 FROM app.stock_threshold WHERE category_id = $1 AND company_id = $2 LIMIT 1', [cat.id, actor.companyId]);
  if ((await modelCount(db, actor, cat.id)) > 0 || thresholds.rowCount) throw inUse();
  await mapDbError(db.query('DELETE FROM app.category WHERE id = $1 AND company_id = $2', [cat.id, actor.companyId]), { '23503': inUse });
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'CATEGORY_DELETED', resource: RESOURCE, targetId: cat.id,
    before: { kind: cat.kind, name: cat.name }, ip: actor.auditIp,
  });
}
