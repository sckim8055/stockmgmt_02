// 역할 관리. 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
import type { Db } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import { actorPermissions, lockCompanyAdministration, permKey, withinPermissions } from '@/lib/authz/grants';
import { HttpError, badRequest, forbidden, notFound } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';

export interface AclEntry {
  resource: string;
  operation: string;
}

export async function listResources(db: Db): Promise<unknown[]> {
  const { rows } = await db.query(
    `SELECT r.code, r.parent_code, r.type, r.sort_order,
            coalesce((SELECT json_agg(o.operation ORDER BY o.operation)
                        FROM app.sys_resource_operation o WHERE o.resource_code = r.code), '[]'::json) AS operations
       FROM app.sys_resource r
      ORDER BY r.parent_code NULLS FIRST, r.sort_order, r.code`,
  );
  return rows;
}

export async function listRoles(db: Db, actor: Actor): Promise<unknown[]> {
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.description, r.is_active,
            (SELECT count(*)::int FROM app.user_role ur WHERE ur.role_id = r.id) AS user_count,
            coalesce((SELECT json_agg(json_build_object('resource', a.resource_code, 'operation', a.operation)
                                      ORDER BY a.resource_code, a.operation)
                        FROM app.role_acl a WHERE a.role_id = r.id), '[]'::json) AS acl
       FROM app.role r
      WHERE r.company_id = $1
      ORDER BY lower(r.name)`,
    [actor.companyId], // 시스템 템플릿(company_id NULL)은 목록에 넣지 않는다.
  );
  return rows;
}

/** 허용 목록이 유효하고, 요청자가 줄 수 있는 범위 안인지 확인한다. */
async function assertAclAllowed(db: Db, actor: Actor, acl: AclEntry[]): Promise<void> {
  const keys = acl.map((a) => permKey(a.resource, a.operation));
  if (new Set(keys).size !== keys.length) throw badRequest('중복된 권한 항목이 있습니다.');
  if (acl.some((a) => a.resource.startsWith('system.'))) throw badRequest('역할에 넣을 수 없는 리소스입니다.');
  if (acl.length > 0) {
    const valid = await db.query<{ k: string }>(
      `SELECT resource_code || ':' || operation AS k FROM app.sys_resource_operation
        WHERE (resource_code, operation) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [acl.map((a) => a.resource), acl.map((a) => a.operation)],
    );
    if (valid.rows.length !== acl.length) throw badRequest('정의되지 않은 권한 항목이 있습니다.');
  }
  if (!withinPermissions(keys, await actorPermissions(db, actor))) {
    throw forbidden('자신이 갖지 않은 권한은 역할에 넣을 수 없습니다.');
  }
}

async function writeAcl(db: Db, roleId: string, acl: AclEntry[]): Promise<void> {
  await db.query('DELETE FROM app.role_acl WHERE role_id = $1', [roleId]);
  if (acl.length > 0) {
    await db.query(
      'INSERT INTO app.role_acl (role_id, resource_code, operation) SELECT $1, * FROM unnest($2::text[], $3::text[])',
      [roleId, acl.map((a) => a.resource), acl.map((a) => a.operation)],
    );
  }
}

async function currentAcl(db: Db, roleId: string): Promise<string[]> {
  const { rows } = await db.query<{ resource_code: string; operation: string }>(
    'SELECT resource_code, operation FROM app.role_acl WHERE role_id = $1 ORDER BY 1, 2',
    [roleId],
  );
  return rows.map((a) => permKey(a.resource_code, a.operation));
}

/** 자기 기업의 역할을 찾는다. 요청자가 가진 권한보다 큰 역할은 고칠 수 없다. */
async function loadEditable(db: Db, actor: Actor, roleId: string): Promise<{ id: string; name: string; acl: string[] }> {
  const { rows } = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM app.role WHERE id = $1 AND company_id = $2 FOR NO KEY UPDATE',
    [roleId, actor.companyId],
  );
  const role = rows[0];
  if (!role) throw notFound(); // 다른 기업의 역할과 시스템 템플릿은 존재하지 않는 것으로 응답한다.
  const acl = await currentAcl(db, role.id);
  if (!withinPermissions(acl, await actorPermissions(db, actor))) {
    throw forbidden('자신이 갖지 않은 권한이 포함된 역할은 수정할 수 없습니다.');
  }
  return { ...role, acl };
}

const duplicateName = () => new HttpError(409, 'DUPLICATE', '같은 이름의 역할이 이미 있습니다.');

async function assertNameFree(db: Db, actor: Actor, name: string, exceptId: string | null): Promise<void> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM app.role WHERE company_id = $1 AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3)',
    [actor.companyId, name, exceptId],
  );
  if (rowCount) throw duplicateName();
}

export async function createRole(
  db: Db,
  actor: Actor,
  input: { name: string; description?: string | null; acl: AclEntry[] },
  ip: string | null,
): Promise<string> {
  await lockCompanyAdministration(db, actor.companyId);
  await assertAclAllowed(db, actor, input.acl);
  await assertNameFree(db, actor, input.name, null);
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO app.role (company_id, name, description) VALUES ($1, $2, $3) RETURNING id',
    [actor.companyId, input.name, input.description || null],
  );
  const roleId = rows[0]!.id;
  await writeAcl(db, roleId, input.acl);
  await writeAudit(db, {
    companyId: actor.companyId,
    actorId: actor.userId,
    action: 'ROLE_CREATED',
    resource: 'admin.role',
    targetId: roleId,
    after: { name: input.name, acl: input.acl.map((a) => permKey(a.resource, a.operation)) },
    ip,
  });
  return roleId;
}

export async function updateRole(
  db: Db,
  actor: Actor,
  roleId: string,
  input: { name?: string; description?: string | null; isActive?: boolean; acl?: AclEntry[] },
  ip: string | null,
): Promise<void> {
  await lockCompanyAdministration(db, actor.companyId);
  const role = await loadEditable(db, actor, roleId);
  if (input.acl) await assertAclAllowed(db, actor, input.acl);
  if (input.name !== undefined) await assertNameFree(db, actor, input.name, role.id);
  await db.query(
    `UPDATE app.role
        SET name = coalesce($2, name),
            description = CASE WHEN $3::boolean THEN $4 ELSE description END,
            is_active = coalesce($5, is_active)
      WHERE id = $1`,
    [role.id, input.name ?? null, input.description !== undefined, input.description || null, input.isActive ?? null],
  );
  if (input.acl) await writeAcl(db, role.id, input.acl);
  await writeAudit(db, {
    companyId: actor.companyId,
    actorId: actor.userId,
    action: 'ROLE_UPDATED',
    resource: 'admin.role',
    targetId: role.id,
    before: { name: role.name, acl: role.acl },
    after: { name: input.name, isActive: input.isActive, acl: input.acl?.map((a) => permKey(a.resource, a.operation)) },
    ip,
  });
}

export async function deleteRole(db: Db, actor: Actor, roleId: string, ip: string | null): Promise<void> {
  await lockCompanyAdministration(db, actor.companyId);
  const role = await loadEditable(db, actor, roleId);
  const used = await db.query('SELECT 1 FROM app.user_role WHERE role_id = $1 LIMIT 1', [role.id]);
  if (used.rowCount) throw new HttpError(409, 'IN_USE', '사용자에게 배정된 역할은 삭제할 수 없습니다. 비활성화하세요.');
  await db.query('DELETE FROM app.role WHERE id = $1', [role.id]);
  await writeAudit(db, {
    companyId: actor.companyId,
    actorId: actor.userId,
    action: 'ROLE_DELETED',
    resource: 'admin.role',
    targetId: role.id,
    before: { name: role.name, acl: role.acl },
    ip,
  });
}
