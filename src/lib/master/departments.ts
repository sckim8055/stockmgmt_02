// 부서. 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 규칙
//  - 이름은 기업 안에서 고유하다(대소문자 무시).
//  - 기본 부서(is_default)는 비활성화·삭제할 수 없고, 기본 지정을 해제하는 API는 없다(DB 트리거·CHECK 도 같은 규칙을 강제한다).
//  - 어디에서든 참조되는 부서는 삭제할 수 없다. 비활성화하면 새 기록에서 고를 수 없게 된다
//    (자산·사용자 범위·직원 등록은 모두 활성 부서만 받는다).
//  - 부서 구조 변경은 부서 범위 제한이 없는 사용자만 한다. 범위가 제한된 사용자가 다른 부서의 이름을 바꾸거나
//    비활성화해서 남의 업무에 영향을 주는 것을 막는다.
//  - 부서는 계정의 부서 범위와 얽혀 있으므로 계정·역할 관리와 같은 기업 단위 잠금으로 줄을 세운다.
import type { Db } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import { actorScope, lockCompanyAdministration } from '@/lib/authz/grants';
import { forbidden, notFound } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { conflict, mapDbError } from './common';

const RESOURCE = 'master.department';

// 이 응답 형식은 사용자 관리 화면(부서 범위 선택)도 쓴다. 컬럼을 바꾸지 않는다.
const SQL_DEPARTMENT_LIST =
  'SELECT id, name, is_default, is_active FROM app.department WHERE company_id = $1 ORDER BY is_default DESC, name';

// 부서를 참조하는 모든 곳. 하나라도 있으면 삭제할 수 없다.
const SQL_DEPARTMENT_IN_USE =
  'SELECT' +
  ' (SELECT count(*)::int FROM app.asset WHERE company_id = $2 AND department_id = $1) AS assets,' +
  ' (SELECT count(*)::int FROM app.peripheral_stock WHERE company_id = $2 AND department_id = $1) AS peripheral_stock,' +
  ' (SELECT count(*)::int FROM app.person WHERE company_id = $2 AND department_id = $1) AS persons,' +
  ' (SELECT count(*)::int FROM app.user_department_scope WHERE company_id = $2 AND department_id = $1) AS user_scopes,' +
  ' (SELECT count(*)::int FROM app.stock_threshold WHERE company_id = $2 AND department_id = $1) AS thresholds,' +
  ' (SELECT count(*)::int FROM app.mail_schedule WHERE company_id = $2 AND department_id = $1) AS mail_schedules,' +
  ' (SELECT count(*)::int FROM app.asset_txn WHERE company_id = $2 AND (from_department_id = $1 OR to_department_id = $1)) AS history';

export interface DepartmentRow {
  id: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
}

export async function listDepartments(db: Db, actor: Actor): Promise<DepartmentRow[]> {
  const { rows } = await db.query<DepartmentRow>(SQL_DEPARTMENT_LIST, [actor.companyId]);
  return rows;
}

const duplicateName = () => conflict('DUPLICATE', '같은 이름의 부서가 이미 있습니다.');
const defaultProtected = () => conflict('DEFAULT_DEPARTMENT', '기본 부서는 비활성화하거나 삭제할 수 없습니다.');

/** 부서 구조는 부서 범위 제한이 없는 사용자만 바꾼다. */
async function assertUnrestricted(db: Db, actor: Actor): Promise<void> {
  if ((await actorScope(db, actor)) !== null) {
    throw forbidden('부서 범위가 제한된 사용자는 부서를 등록하거나 변경할 수 없습니다.');
  }
}

async function assertNameFree(db: Db, actor: Actor, name: string, exceptId: string | null): Promise<void> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM app.department WHERE company_id = $1 AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3)',
    [actor.companyId, name, exceptId],
  );
  if (rowCount) throw duplicateName();
}

/** 자기 기업의 부서를 잠그고 읽는다. 다른 기업의 부서는 없는 것으로 응답한다. */
async function lockDepartment(db: Db, actor: Actor, departmentId: string): Promise<DepartmentRow> {
  const { rows } = await db.query<DepartmentRow>(
    'SELECT id, name, is_default, is_active FROM app.department WHERE id = $1 AND company_id = $2 FOR UPDATE',
    [departmentId, actor.companyId],
  );
  const dept = rows[0];
  if (!dept) throw notFound();
  return dept;
}

async function prepare(db: Db, actor: Actor, departmentId: string | null): Promise<DepartmentRow | null> {
  await lockCompanyAdministration(db, actor.companyId);
  await assertUnrestricted(db, actor);
  return departmentId === null ? null : lockDepartment(db, actor, departmentId);
}

export async function createDepartment(db: Db, actor: Actor, input: { name: string }): Promise<string> {
  await prepare(db, actor, null);
  await assertNameFree(db, actor, input.name, null);
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO app.department (company_id, name) VALUES ($1, $2) RETURNING id',
    [actor.companyId, input.name],
  );
  const id = rows[0]!.id;
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'DEPARTMENT_CREATED', resource: RESOURCE, targetId: id,
    after: { name: input.name }, ip: actor.auditIp,
  });
  return id;
}

export async function updateDepartment(db: Db, actor: Actor, departmentId: string, input: { name?: string }): Promise<void> {
  const dept = (await prepare(db, actor, departmentId))!;
  if (input.name === undefined || input.name === dept.name) return;
  await assertNameFree(db, actor, input.name, dept.id);
  await db.query('UPDATE app.department SET name = $2 WHERE id = $1 AND company_id = $3', [dept.id, input.name, actor.companyId]);
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'DEPARTMENT_UPDATED', resource: RESOURCE, targetId: dept.id,
    before: { name: dept.name }, after: { name: input.name }, ip: actor.auditIp,
  });
}

/**
 * 활성/비활성 전환. 비활성 부서는 새 자산·직원·사용자 범위에서 고를 수 없을 뿐, 이미 그 부서에 속한 기록은 그대로 둔다.
 * (사용 중인 부서의 비활성화를 막으면, 조직 개편 때 모든 자산을 먼저 옮겨야만 부서를 닫을 수 있게 된다)
 */
export async function setDepartmentActive(db: Db, actor: Actor, departmentId: string, active: boolean): Promise<void> {
  const dept = (await prepare(db, actor, departmentId))!;
  if (!active && dept.is_default) throw defaultProtected();
  if (dept.is_active === active) return;
  await mapDbError(
    db.query('UPDATE app.department SET is_active = $2 WHERE id = $1 AND company_id = $3', [dept.id, active, actor.companyId]),
    { '23514': defaultProtected },
  );
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: active ? 'DEPARTMENT_ACTIVATED' : 'DEPARTMENT_DEACTIVATED',
    resource: RESOURCE, targetId: dept.id, before: { name: dept.name }, ip: actor.auditIp,
  });
}

export async function deleteDepartment(db: Db, actor: Actor, departmentId: string): Promise<void> {
  const dept = (await prepare(db, actor, departmentId))!;
  if (dept.is_default) throw defaultProtected();
  const usage = (await db.query<Record<string, number>>(SQL_DEPARTMENT_IN_USE, [dept.id, actor.companyId])).rows[0]!;
  const inUse = () => conflict('IN_USE', '사용 중인 부서는 삭제할 수 없습니다. 대신 비활성화하세요.');
  if (Object.values(usage).some((n) => n > 0)) throw inUse();
  await mapDbError(db.query('DELETE FROM app.department WHERE id = $1 AND company_id = $2', [dept.id, actor.companyId]), {
    '23503': inUse, // 검사 직후 다른 요청이 이 부서를 참조한 경우
    '23514': defaultProtected,
  });
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'DEPARTMENT_DELETED', resource: RESOURCE, targetId: dept.id,
    before: { name: dept.name }, ip: actor.auditIp,
  });
}
