// 사용자 관리. 모든 함수는 tenant() 트랜잭션 안에서 호출한다(다른 기업 계정은 RLS로 보이지 않는다).
import type { Db } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import { TEMP_PASSWORD_TTL_HOURS } from '@/lib/auth/password';
import { revokeAllSessions } from '@/lib/auth/session';
import { actorPermissions, actorScope, permKey, userPermissions, userScope, withinPermissions, withinScope } from '@/lib/authz/grants';
import { HttpError, badRequest, forbidden, notFound } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';

type ManagedType = 'COMPANY_ADMIN' | 'COMPANY_USER';

interface TargetRow {
  id: string;
  login_id: string;
  user_type: ManagedType;
  is_active: boolean;
}

const dup = (ids: string[]) => new Set(ids).size !== ids.length;

export async function listUsers(db: Db): Promise<unknown[]> {
  const { rows } = await db.query(
    `SELECT u.id, u.login_id, u.display_name, u.email, u.user_type, u.lang, u.is_active, u.must_change_password,
            (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked, u.created_at,
            coalesce((SELECT json_agg(json_build_object('id', r.id, 'name', r.name) ORDER BY r.name)
                        FROM app.user_role ur JOIN app.role r ON r.id = ur.role_id
                       WHERE ur.user_id = u.id), '[]'::json) AS roles,
            coalesce((SELECT json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.name)
                        FROM app.user_department_scope s JOIN app.department d ON d.id = s.department_id
                       WHERE s.user_id = u.id), '[]'::json) AS departments
       FROM app.app_user u
      ORDER BY lower(u.login_id)`,
  );
  return rows;
}

/** 요청자가 이 역할들과 부서 범위를 남에게 줄 수 있는지 확인한다. 안 되면 예외. */
/**
 * roleIds / departmentIds 가 undefined 이면 그 항목은 바꾸지 않는다는 뜻이므로 검사하지 않는다.
 */
async function assertGrantable(
  db: Db,
  actor: Actor,
  roleIds: string[] | undefined,
  departmentIds: string[] | undefined,
): Promise<void> {
  if ((roleIds && dup(roleIds)) || (departmentIds && dup(departmentIds))) throw badRequest('중복된 항목이 있습니다.');

  if (roleIds && roleIds.length > 0) {
    const roles = await db.query<{ id: string }>(
      'SELECT id FROM app.role WHERE id = ANY($1::uuid[]) AND company_id = $2 AND is_active',
      [roleIds, actor.companyId],
    );
    if (roles.rows.length !== roleIds.length) throw badRequest('배정할 수 없는 역할이 있습니다.');
  }
  if (departmentIds && departmentIds.length > 0) {
    const depts = await db.query<{ id: string }>(
      'SELECT id FROM app.department WHERE id = ANY($1::uuid[]) AND is_active',
      [departmentIds],
    );
    if (depts.rows.length !== departmentIds.length) throw badRequest('지정할 수 없는 부서가 있습니다.');
  }
  if (actor.isAdmin) return;

  if (roleIds) {
    // 자기가 가진 권한보다 큰 역할은 줄 수 없다.
    const mine = await actorPermissions(db, actor);
    const acl = await db.query<{ resource_code: string; operation: string }>(
      'SELECT resource_code, operation FROM app.role_acl WHERE role_id = ANY($1::uuid[])',
      [roleIds],
    );
    if (!withinPermissions(acl.rows.map((a) => permKey(a.resource_code, a.operation)), mine)) {
      throw forbidden('자신이 갖지 않은 권한이 포함된 역할은 배정할 수 없습니다.');
    }
  }
  if (departmentIds) {
    // 자기 부서 범위 밖으로 넓혀 줄 수 없다. 빈 목록은 "전체 부서"이므로, 범위가 제한된 요청자는 줄 수 없다.
    const myScope = await actorScope(db, actor);
    if (!withinScope(departmentIds.length === 0 ? null : departmentIds, myScope)) {
      throw forbidden('자신의 부서 범위를 벗어난 범위는 지정할 수 없습니다.');
    }
  }
}

/** 대상 계정을 찾고, 요청자가 그 계정을 관리할 수 있는지 확인한다. */
async function loadManageable(db: Db, actor: Actor, targetId: string): Promise<TargetRow> {
  const { rows } = await db.query<TargetRow>(
    'SELECT id, login_id, user_type, is_active FROM app.app_user WHERE id = $1 AND company_id = $2 FOR UPDATE',
    [targetId, actor.companyId],
  );
  const target = rows[0];
  if (!target) throw notFound(); // 다른 기업 계정·시스템 관리자는 존재하지 않는 것으로 응답한다.
  if (actor.isAdmin) return target;

  if (target.user_type !== 'COMPANY_USER') throw forbidden('기업 관리자 계정은 관리할 수 없습니다.');
  // 자기보다 권한이 크거나 범위가 넓은 계정은 건드릴 수 없다.
  // (그런 계정의 임시 비밀번호를 발급받으면 그 권한을 통째로 얻게 된다)
  const [mine, theirs, myScope, theirScope] = [
    await actorPermissions(db, actor),
    await userPermissions(db, target.id),
    await actorScope(db, actor),
    await userScope(db, target.id),
  ];
  if (!withinPermissions(theirs, mine) || !withinScope(theirScope, myScope)) {
    throw forbidden('자신보다 권한이나 범위가 큰 계정은 관리할 수 없습니다.');
  }
  return target;
}

async function replaceRolesAndScope(
  db: Db,
  actor: Actor,
  userId: string,
  roleIds: string[] | undefined,
  departmentIds: string[] | undefined,
): Promise<void> {
  if (roleIds) {
    await db.query('DELETE FROM app.user_role WHERE user_id = $1', [userId]);
    if (roleIds.length > 0) {
      await db.query(
        'INSERT INTO app.user_role (user_id, role_id, company_id) SELECT $1, r, $3 FROM unnest($2::uuid[]) AS r',
        [userId, roleIds, actor.companyId],
      );
    }
  }
  if (departmentIds) {
    await db.query('DELETE FROM app.user_department_scope WHERE user_id = $1', [userId]);
    if (departmentIds.length > 0) {
      await db.query(
        'INSERT INTO app.user_department_scope (user_id, department_id, company_id) SELECT $1, d, $3 FROM unnest($2::uuid[]) AS d',
        [userId, departmentIds, actor.companyId],
      );
    }
  }
}

export interface CreateUserInput {
  loginId: string;
  displayName: string;
  email?: string | null;
  lang?: 'ko' | 'en' | 'zh';
  userType: ManagedType;
  roleIds: string[];
  departmentIds: string[];
}

/** 계정을 만든다. passwordHash 는 호출자가 트랜잭션 밖에서 미리 계산한 임시 비밀번호의 해시다. */
export async function createUser(
  db: Db,
  actor: Actor,
  input: CreateUserInput,
  passwordHash: string,
  ip: string | null,
): Promise<string> {
  if (input.userType === 'COMPANY_ADMIN') {
    if (!actor.isAdmin) throw forbidden('기업 관리자 계정은 만들 수 없습니다.');
    if (input.roleIds.length > 0 || input.departmentIds.length > 0) {
      throw badRequest('기업 관리자에게는 역할과 부서 범위를 지정하지 않습니다.');
    }
  }
  await assertGrantable(db, actor, input.roleIds, input.departmentIds);

  const exists = await db.query('SELECT 1 FROM app.app_user WHERE company_id = $1 AND lower(login_id) = lower($2)', [
    actor.companyId,
    input.loginId,
  ]);
  if (exists.rowCount) throw new HttpError(409, 'DUPLICATE', '이미 사용 중인(또는 과거에 사용한) 로그인 ID입니다.');

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO app.app_user
       (company_id, login_id, password_hash, email, display_name, user_type, lang,
        must_change_password, temp_password_expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, now() + make_interval(hours => $8), $9)
     RETURNING id`,
    [
      actor.companyId,
      input.loginId,
      passwordHash,
      input.email || null,
      input.displayName,
      input.userType,
      input.lang ?? 'ko',
      TEMP_PASSWORD_TTL_HOURS,
      actor.userId,
    ],
  );
  const userId = rows[0]!.id;
  await replaceRolesAndScope(db, actor, userId, input.roleIds, input.departmentIds);
  await writeAudit(db, {
    companyId: actor.companyId,
    actorId: actor.userId,
    action: 'USER_CREATED',
    resource: 'admin.user',
    targetId: userId,
    after: { loginId: input.loginId, userType: input.userType, roleIds: input.roleIds, departmentIds: input.departmentIds },
    ip,
  });
  return userId;
}

export interface UpdateUserInput {
  displayName?: string;
  email?: string | null;
  lang?: 'ko' | 'en' | 'zh';
  userType?: ManagedType;
  roleIds?: string[];
  departmentIds?: string[];
}

export async function updateUser(db: Db, actor: Actor, targetId: string, input: UpdateUserInput, ip: string | null): Promise<void> {
  const target = await loadManageable(db, actor, targetId);
  const changesAccess = input.userType !== undefined || input.roleIds !== undefined || input.departmentIds !== undefined;
  // 누구도 자기 계정의 유형·역할·부서 범위를 스스로 바꿀 수 없다.
  if (changesAccess && target.id === actor.userId) throw forbidden('자신의 권한은 스스로 바꿀 수 없습니다.');

  const newType = input.userType ?? target.user_type;
  if (input.userType !== undefined && input.userType !== target.user_type) {
    if (!actor.isAdmin) throw forbidden('계정 유형은 관리자만 바꿀 수 있습니다.');
    if (target.user_type === 'COMPANY_ADMIN') await assertNotLastAdmin(db, actor, target.id);
  }
  if (newType === 'COMPANY_ADMIN') {
    if ((input.roleIds?.length ?? 0) > 0 || (input.departmentIds?.length ?? 0) > 0) {
      throw badRequest('기업 관리자에게는 역할과 부서 범위를 지정하지 않습니다.');
    }
  }

  const before = { roles: [...(await roleIdsOf(db, target.id))], scope: await userScope(db, target.id), userType: target.user_type };
  await assertGrantable(db, actor, input.roleIds, input.departmentIds);

  await db.query(
    `UPDATE app.app_user
        SET display_name = coalesce($2, display_name),
            email = CASE WHEN $3::boolean THEN $4 ELSE email END,
            lang = coalesce($5, lang),
            user_type = coalesce($6, user_type)
      WHERE id = $1`,
    [target.id, input.displayName ?? null, input.email !== undefined, input.email || null, input.lang ?? null, input.userType ?? null],
  );
  if (newType === 'COMPANY_ADMIN' && target.user_type !== 'COMPANY_ADMIN') {
    // 관리자로 올리면 역할·범위는 의미가 없으므로 비운다.
    await replaceRolesAndScope(db, actor, target.id, [], []);
  } else {
    await replaceRolesAndScope(db, actor, target.id, input.roleIds, input.departmentIds);
  }
  await writeAudit(db, {
    companyId: actor.companyId,
    actorId: actor.userId,
    action: 'USER_UPDATED',
    resource: 'admin.user',
    targetId: target.id,
    before,
    after: { userType: newType, roleIds: input.roleIds, departmentIds: input.departmentIds, displayName: input.displayName },
    ip,
  });
}

async function roleIdsOf(db: Db, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ role_id: string }>('SELECT role_id FROM app.user_role WHERE user_id = $1', [userId]);
  return rows.map((r) => r.role_id);
}

/** 기업의 마지막 활성 관리자를 없애는 변경은 시스템 관리자만 할 수 있다. */
async function assertNotLastAdmin(db: Db, actor: Actor, targetId: string): Promise<void> {
  if (actor.userType === 'SYSTEM_ADMIN') return;
  // 동시에 두 관리자가 서로를 비활성화해 관리자가 0명이 되는 것을 막기 위해 관리자 행을 잠근다.
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM app.app_user WHERE company_id = $1 AND user_type = 'COMPANY_ADMIN' AND is_active ORDER BY id FOR UPDATE",
    [actor.companyId],
  );
  if (rows.filter((r) => r.id !== targetId).length === 0) {
    throw new HttpError(409, 'LAST_ADMIN', '기업의 마지막 관리자는 시스템 관리자만 변경할 수 있습니다.');
  }
}

export async function setUserActive(db: Db, actor: Actor, targetId: string, active: boolean, ip: string | null): Promise<void> {
  const target = await loadManageable(db, actor, targetId);
  if (target.id === actor.userId) throw forbidden('자신의 계정 상태는 스스로 바꿀 수 없습니다.');
  if (target.is_active === active) return;
  if (!active && target.user_type === 'COMPANY_ADMIN') await assertNotLastAdmin(db, actor, target.id);

  await db.query('UPDATE app.app_user SET is_active = $2 WHERE id = $1', [target.id, active]);
  if (!active) await revokeAllSessions(db, target.id);
  await writeAudit(db, {
    companyId: actor.companyId,
    actorId: actor.userId,
    action: active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
    resource: 'admin.user',
    targetId: target.id,
    ip,
  });
}

/** 임시 비밀번호로 교체한다. 기존 세션을 모두 끊고 잠금을 푼다. passwordHash 는 호출자가 미리 계산한다. */
export async function applyTempPassword(db: Db, actor: Actor, targetId: string, passwordHash: string, ip: string | null): Promise<void> {
  const target = await loadManageable(db, actor, targetId);
  if (target.id === actor.userId) throw forbidden('자신의 비밀번호는 비밀번호 변경 화면에서 바꿉니다.');
  if (!target.is_active) throw badRequest('비활성 계정입니다.');
  await db.query(
    `UPDATE app.app_user
        SET password_hash = $2, must_change_password = true,
            temp_password_expires_at = now() + make_interval(hours => $3),
            failed_count = 0, locked_until = NULL
      WHERE id = $1`,
    [target.id, passwordHash, TEMP_PASSWORD_TTL_HOURS],
  );
  await revokeAllSessions(db, target.id);
  await writeAudit(db, {
    companyId: actor.companyId,
    actorId: actor.userId,
    action: 'TEMP_PASSWORD_ISSUED',
    resource: 'admin.user.password',
    targetId: target.id,
    ip,
  });
}

export async function unlockUser(db: Db, actor: Actor, targetId: string, ip: string | null): Promise<void> {
  const target = await loadManageable(db, actor, targetId);
  await db.query('UPDATE app.app_user SET failed_count = 0, locked_until = NULL WHERE id = $1', [target.id]);
  await writeAudit(db, {
    companyId: actor.companyId,
    actorId: actor.userId,
    action: 'USER_UNLOCKED',
    resource: 'admin.user',
    targetId: target.id,
    ip,
  });
}
