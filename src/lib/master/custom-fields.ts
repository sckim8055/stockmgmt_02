// 사용자 지정 필드 정의. 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 규칙
//  - 키(key)와 데이터 형식(data_type)은 만든 뒤 바꿀 수 없다(자산에 저장된 값의 의미가 바뀌기 때문).
//  - 키는 기업 안에서 고유하다.
//  - 값이 하나라도 저장된 필드는 삭제할 수 없다. is_active=false 로 숨긴다
//    (비활성 필드는 자산 응답에서 빠지고 입력도 받지 않는다: src/lib/assets/assets.ts).
import type { Db } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import { loadDataAccess } from '@/lib/authz/scope';
import { badRequest, forbidden, notFound } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { conflict, lockMasterData } from './common';

const RESOURCE = 'master.custom_field';

export type CustomDataType = 'text' | 'number' | 'date' | 'boolean';

export interface CustomFieldRow {
  id: string;
  key: string;
  label: string;
  data_type: CustomDataType;
  is_restricted: boolean;
  sort_order: number;
  is_active: boolean;
}

export async function listCustomFields(db: Db, actor: Actor): Promise<CustomFieldRow[]> {
  const { rows } = await db.query<CustomFieldRow>(
    `SELECT id, key, label, data_type, is_restricted, sort_order, is_active
       FROM app.custom_field_def WHERE company_id = $1 ORDER BY sort_order, key`,
    [actor.companyId],
  );
  return rows;
}

async function lockField(db: Db, actor: Actor, fieldId: string): Promise<CustomFieldRow> {
  await lockMasterData(db, actor.companyId);
  const { rows } = await db.query<CustomFieldRow>(
    `SELECT id, key, label, data_type, is_restricted, sort_order, is_active
       FROM app.custom_field_def WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [fieldId, actor.companyId],
  );
  const field = rows[0];
  if (!field) throw notFound();
  return field;
}

export interface CustomFieldInput {
  key: string;
  label: string;
  dataType: CustomDataType;
  isRestricted?: boolean;
  sortOrder?: number;
  isActive?: boolean;
}

export async function createCustomField(db: Db, actor: Actor, input: CustomFieldInput): Promise<string> {
  await lockMasterData(db, actor.companyId);
  const dup = await db.query('SELECT 1 FROM app.custom_field_def WHERE company_id = $1 AND key = $2', [actor.companyId, input.key]);
  if (dup.rowCount) throw conflict('DUPLICATE', '같은 키의 사용자 지정 필드가 이미 있습니다.');
  if (!(input.isRestricted ?? false)) {
    // 예전에 같은 키로 저장된 값이 남아 있을 수 있다(삭제 검사와 자산 저장이 겹친 경우). 그 키가 제한 필드였을 수 있으므로
    // 일반 필드로 다시 만들어 값을 드러내지 못하게 한다.
    const leftover = await db.query('SELECT 1 FROM app.asset WHERE company_id = $1 AND custom ? $2 LIMIT 1', [actor.companyId, input.key]);
    if (leftover.rowCount) throw conflict('IN_USE', '이 키로 저장된 값이 남아 있습니다. 제한 필드로 만들거나 다른 키를 쓰세요.');
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO app.custom_field_def (company_id, key, label, data_type, is_restricted, sort_order, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [actor.companyId, input.key, input.label, input.dataType, input.isRestricted ?? false, input.sortOrder ?? 0, input.isActive ?? true],
  );
  const id = rows[0]!.id;
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'CUSTOM_FIELD_CREATED', resource: RESOURCE, targetId: id,
    after: { key: input.key, label: input.label, dataType: input.dataType, isRestricted: input.isRestricted ?? false },
    ip: actor.auditIp,
  });
  return id;
}

export interface CustomFieldPatch {
  /** 바꿀 수 없다. 같은 값이면 무시하고, 다르면 거부한다(화면이 전체 값을 보내는 경우를 위해 받는다). */
  key?: string;
  dataType?: CustomDataType;
  label?: string;
  isRestricted?: boolean;
  sortOrder?: number;
  isActive?: boolean;
}

export async function updateCustomField(db: Db, actor: Actor, fieldId: string, input: CustomFieldPatch): Promise<void> {
  const field = await lockField(db, actor, fieldId);
  if ((input.key !== undefined && input.key !== field.key) || (input.dataType !== undefined && input.dataType !== field.data_type)) {
    throw badRequest('키와 데이터 형식은 만든 뒤에 바꿀 수 없습니다.');
  }
  const { key: _key, dataType: _dataType, ...changes } = input;
  // 제한 여부를 바꾸면 그 필드의 값을 볼 수 있는 사람이 달라진다. 기준 정보 수정 권한만으로는 바꿀 수 없고,
  // 제한 필드를 읽고 쓸 수 있는 사람(값을 이미 볼 수 있는 사람)만 바꾼다.
  if (changes.isRestricted !== undefined && changes.isRestricted !== field.is_restricted) {
    const access = await loadDataAccess(db, actor);
    if (!access.canReadField('custom_restricted') || !access.canUpdateField('custom_restricted')) {
      throw forbidden('제한 여부는 제한된 사용자 지정 필드의 조회·수정 권한이 있어야 바꿀 수 있습니다.');
    }
  }
  if (Object.values(changes).every((v) => v === undefined)) return;
  await db.query(
    `UPDATE app.custom_field_def
        SET label = coalesce($2, label),
            is_restricted = coalesce($3, is_restricted),
            sort_order = coalesce($4, sort_order),
            is_active = coalesce($5, is_active)
      WHERE id = $1 AND company_id = $6`,
    [field.id, changes.label ?? null, changes.isRestricted ?? null, changes.sortOrder ?? null, changes.isActive ?? null, actor.companyId],
  );
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'CUSTOM_FIELD_UPDATED', resource: RESOURCE, targetId: field.id,
    before: { key: field.key, label: field.label, isRestricted: field.is_restricted, isActive: field.is_active },
    after: changes,
    ip: actor.auditIp,
  });
}

export async function deleteCustomField(db: Db, actor: Actor, fieldId: string): Promise<void> {
  const field = await lockField(db, actor, fieldId);
  // 자산 쓰기는 이 잠금을 잡지 않으므로, 검사 직후 다른 요청이 값을 넣을 가능성은 남는다.
  // 그 경우에도 정의가 없는 키의 값은 자산 응답에서 빠지므로 노출되지는 않는다.
  const used = await db.query('SELECT 1 FROM app.asset WHERE company_id = $1 AND custom ? $2 LIMIT 1', [actor.companyId, field.key]);
  if (used.rowCount) throw conflict('IN_USE', '값이 저장된 자산이 있어 삭제할 수 없습니다. 대신 사용 안 함(is_active=false)으로 바꾸세요.');
  await db.query('DELETE FROM app.custom_field_def WHERE id = $1 AND company_id = $2', [field.id, actor.companyId]);
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'CUSTOM_FIELD_DELETED', resource: RESOURCE, targetId: field.id,
    before: { key: field.key, label: field.label, dataType: field.data_type }, ip: actor.auditIp,
  });
}
