// 1단계: 사용자·역할 관리, 권한 상승 방지, 부서 범위, 시스템 관리자의 기업 선택.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as resourcesList } from '@/app/api/admin/resources/route';
import { DELETE as roleDelete, PATCH as rolePatch } from '@/app/api/admin/roles/[id]/route';
import { GET as rolesList, POST as rolesCreate } from '@/app/api/admin/roles/route';
import { POST as userActivate } from '@/app/api/admin/users/[id]/activate/route';
import { POST as userDeactivate } from '@/app/api/admin/users/[id]/deactivate/route';
import { PATCH as userPatch } from '@/app/api/admin/users/[id]/route';
import { POST as userTempPassword } from '@/app/api/admin/users/[id]/temp-password/route';
import { POST as userUnlock } from '@/app/api/admin/users/[id]/unlock/route';
import { GET as usersList, POST as usersCreate } from '@/app/api/admin/users/route';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { GET as mePermissions } from '@/app/api/me/permissions/route';
import { GET as meRoute } from '@/app/api/me/route';
import { POST as actingCompany } from '@/app/api/system/acting-company/route';
import { login } from '@/lib/auth/login';
import { withTenant } from '@/lib/db/context';
import { closePool } from '@/lib/db/pool';
import { call, closeOwner, GOOD_PASSWORD, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const dept: Record<string, string> = {};
const role: Record<string, string> = {};
const user: Record<string, string> = {};
const cookie: Record<string, string> = {};
let bUserId: string;
let bRoleId: string;
let bDeptId: string;
let rootLogin: string;

type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
/** [id] 가 있는 라우트를 호출한다. */
const withId = (h: Handler, id: string) => (req: Request) => h(req, { params: Promise.resolve({ id }) });

async function makeRole(companyId: string, name: string, acl: Array<[string, string]>): Promise<string> {
  const o = await owner();
  const r = await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [companyId, name]);
  for (const [res, op] of acl) {
    await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [r.rows[0].id, res, op]);
  }
  return r.rows[0].id;
}
async function assign(companyId: string, userId: string, roleIds: string[], deptIds: string[] = []): Promise<void> {
  const o = await owner();
  for (const r of roleIds) await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [userId, r, companyId]);
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [userId, d, companyId]);
}

const USER_ADMIN_ACL: Array<[string, string]> = [
  ['admin.user', 'read'], ['admin.user', 'create'], ['admin.user', 'update'], ['admin.user', 'activate'], ['admin.user', 'deactivate'],
  ['admin.user.password', 'execute'],
  ['admin.role', 'read'], ['admin.role', 'create'], ['admin.role', 'update'], ['admin.role', 'delete'],
  ['master.department', 'read'], ['dashboard', 'read'],
];

beforeAll(async () => {
  A = await makeCompany('ADMA');
  B = await makeCompany('ADMB');
  const o = await owner();
  dept.it = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A.id])).rows[0].id;
  dept.hr = (await o.query("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [A.id])).rows[0].id;
  dept.fin = (await o.query("INSERT INTO app.department (company_id, name) VALUES ($1, 'Finance') RETURNING id", [A.id])).rows[0].id;
  for (const name of ['Viewer', 'Stock Operator', 'Stock Manager']) {
    role[name] = (await o.query('SELECT id FROM app.role WHERE company_id = $1 AND name = $2', [A.id, name])).rows[0].id;
  }
  role.userMgr = await makeRole(A.id, 'User Manager', USER_ADMIN_ACL);
  role.deptReader = await makeRole(A.id, 'Dept Reader', [['master.department', 'read']]);

  user.admin = A.adminUserId;
  user.mgr = await makeUser(A.id, 'mgr', 'COMPANY_USER'); // 사용자·역할 관리 권한을 받은 일반 사용자
  user.op = await makeUser(A.id, 'oper', 'COMPANY_USER'); // 재고 담당 (mgr 보다 다른 방향으로 권한이 큼)
  user.plain = await makeUser(A.id, 'plain', 'COMPANY_USER'); // 역할 없음
  user.reader = await makeUser(A.id, 'reader', 'COMPANY_USER'); // mgr 가 관리할 수 있는 작은 권한
  user.hrMgr = await makeUser(A.id, 'hrmgr', 'COMPANY_USER'); // 부서 범위가 HR 로 제한된 관리 담당
  await assign(A.id, user.mgr, [role.userMgr!]);
  await assign(A.id, user.op, [role['Stock Operator']!]);
  await assign(A.id, user.reader, [role.deptReader!]);
  await assign(A.id, user.hrMgr, [role.userMgr!], [dept.hr!]);

  bUserId = await makeUser(B.id, 'buser', 'COMPANY_USER');
  bRoleId = (await o.query('SELECT id FROM app.role WHERE company_id = $1 LIMIT 1', [B.id])).rows[0].id;
  bDeptId = (await o.query('SELECT id FROM app.department WHERE company_id = $1', [B.id])).rows[0].id;
  rootLogin = uniq('root').toLowerCase();
  await makeUser(null, rootLogin, 'SYSTEM_ADMIN');

  for (const who of ['admin', 'mgr', 'oper', 'plain', 'reader', 'hrmgr']) cookie[who] = await sessionFor(A.code, who);
  cookie.op = cookie.oper!;
  cookie.badmin = await sessionFor(B.code, 'admin');
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

const newUser = (over: Record<string, unknown> = {}) => ({
  loginId: uniq('u').toLowerCase(), displayName: 'New User', userType: 'COMPANY_USER', roleIds: [], departmentIds: [], ...over,
});
const row = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];

describe('사용자 목록', () => {
  it('자기 기업 계정만 나오고, 비밀번호 해시는 응답에 없다', async () => {
    const r = await call(usersList, { cookie: cookie.admin });
    expect(r.status).toBe(200);
    const ids = r.data.users.map((u: { id: string }) => u.id);
    expect(ids).toContain(user.mgr);
    expect(ids).not.toContain(bUserId);
    expect(JSON.stringify(r.data)).not.toMatch(/password_hash|passwordHash|argon2/i);
    const mgr = r.data.users.find((u: { id: string }) => u.id === user.mgr);
    expect(mgr.roles.map((x: { name: string }) => x.name)).toEqual(['User Manager']);
  });

  it('권한이 없으면 403', async () => {
    expect((await call(usersList, { cookie: cookie.plain })).status).toBe(403);
    expect((await call(usersList, { cookie: cookie.op })).status).toBe(403);
    expect((await call(usersList)).status).toBe(401);
  });
});

describe('사용자 생성', () => {
  it('관리자가 만들면 임시 비밀번호가 한 번 내려오고, 첫 로그인에서 변경이 강제된다', async () => {
    const body = newUser({ roleIds: [role.Viewer], departmentIds: [dept.hr] });
    const r = await call(usersCreate, { method: 'POST', cookie: cookie.admin, body });
    expect(r.status).toBe(201);
    const s = await login({ companyCode: A.code, loginId: body.loginId as string, password: r.data.tempPassword });
    expect(s.ok && s.user.mustChangePassword).toBe(true);
    const audit = await row("SELECT after::text AS t FROM app.audit_log WHERE action = 'USER_CREATED' AND target_id = $1", [r.data.userId]);
    expect(audit.t).not.toContain(r.data.tempPassword);
    const scope = await row('SELECT count(*)::int AS n FROM app.user_department_scope WHERE user_id = $1', [r.data.userId]);
    expect(scope.n).toBe(1);
  });

  it('같은 로그인 ID는 대소문자가 달라도, 비활성 계정의 것이어도 다시 쓸 수 없다', async () => {
    const body = newUser();
    const first = await call(usersCreate, { method: 'POST', cookie: cookie.admin, body });
    expect(first.status).toBe(201);
    expect((await call(usersCreate, { method: 'POST', cookie: cookie.admin, body: { ...body, loginId: (body.loginId as string).toUpperCase() } })).status).toBe(409);
    await call(withId(userDeactivate, first.data.userId), { method: 'POST', cookie: cookie.admin });
    expect((await call(usersCreate, { method: 'POST', cookie: cookie.admin, body })).status).toBe(409);
    // 다른 기업에서는 같은 ID를 쓸 수 있다.
    expect((await call(usersCreate, { method: 'POST', cookie: cookie.badmin, body })).status).toBe(201);
  });

  it('다른 기업의 역할·부서는 지정할 수 없다', async () => {
    expect((await call(usersCreate, { method: 'POST', cookie: cookie.admin, body: newUser({ roleIds: [bRoleId] }) })).status).toBe(400);
    expect((await call(usersCreate, { method: 'POST', cookie: cookie.admin, body: newUser({ departmentIds: [bDeptId] }) })).status).toBe(400);
  });

  it('기업 관리자에게는 역할·범위를 지정할 수 없고, 시스템 관리자 유형은 만들 수 없다', async () => {
    expect((await call(usersCreate, { method: 'POST', cookie: cookie.admin, body: newUser({ userType: 'COMPANY_ADMIN', roleIds: [role.Viewer] }) })).status).toBe(400);
    expect((await call(usersCreate, { method: 'POST', cookie: cookie.admin, body: newUser({ userType: 'SYSTEM_ADMIN' }) })).status).toBe(400);
  });
});

describe('권한 상승 방지 (관리 권한을 받은 일반 사용자)', () => {
  it('기업 관리자 계정을 만들 수 없다', async () => {
    expect((await call(usersCreate, { method: 'POST', cookie: cookie.mgr, body: newUser({ userType: 'COMPANY_ADMIN' }) })).status).toBe(403);
  });

  it('자기가 갖지 않은 권한이 든 역할은 남에게 줄 수 없다', async () => {
    for (const name of ['Stock Manager', 'Stock Operator', 'Viewer']) {
      const r = await call(usersCreate, { method: 'POST', cookie: cookie.mgr, body: newUser({ roleIds: [role[name]] }) });
      expect(r.status, name).toBe(403);
    }
    expect((await call(usersCreate, { method: 'POST', cookie: cookie.mgr, body: newUser({ roleIds: [role.deptReader] }) })).status).toBe(201);
  });

  it('자기 계정의 역할·범위·유형은 스스로 바꿀 수 없다 (관리자도 마찬가지)', async () => {
    expect((await call(withId(userPatch, user.mgr!), { method: 'PATCH', cookie: cookie.mgr, body: { roleIds: [role.userMgr, role.deptReader] } })).status).toBe(403);
    expect((await call(withId(userPatch, user.mgr!), { method: 'PATCH', cookie: cookie.mgr, body: { departmentIds: [] } })).status).toBe(403);
    expect((await call(withId(userPatch, user.admin!), { method: 'PATCH', cookie: cookie.admin, body: { userType: 'COMPANY_USER' } })).status).toBe(403);
    expect((await call(withId(userDeactivate, user.admin!), { method: 'POST', cookie: cookie.admin })).status).toBe(403);
    // 이름 같은 개인 정보는 바꿀 수 있다.
    expect((await call(withId(userPatch, user.mgr!), { method: 'PATCH', cookie: cookie.mgr, body: { displayName: 'Manager Kim' } })).status).toBe(200);
  });

  it('자기보다 권한이 큰 계정과 기업 관리자는 건드릴 수 없다 (임시 비밀번호로 계정을 빼앗는 것 포함)', async () => {
    for (const target of [user.op!, user.admin!]) {
      expect((await call(withId(userTempPassword, target), { method: 'POST', cookie: cookie.mgr })).status, 'temp').toBe(403);
      expect((await call(withId(userDeactivate, target), { method: 'POST', cookie: cookie.mgr })).status, 'deact').toBe(403);
      expect((await call(withId(userPatch, target), { method: 'PATCH', cookie: cookie.mgr, body: { roleIds: [] } })).status, 'patch').toBe(403);
      expect((await call(withId(userUnlock, target), { method: 'POST', cookie: cookie.mgr })).status, 'unlock').toBe(403);
    }
    // 대상 계정은 그대로다.
    expect((await login({ companyCode: A.code, loginId: 'oper', password: GOOD_PASSWORD })).ok).toBe(true);
    // 자기보다 작은 계정은 관리할 수 있다.
    expect((await call(withId(userUnlock, user.reader!), { method: 'POST', cookie: cookie.mgr })).status).toBe(200);
  });

  it('역할에 자기가 갖지 않은 권한을 넣을 수 없고, 그런 권한이 든 역할은 고칠 수 없다', async () => {
    const create = await call(rolesCreate, { method: 'POST', cookie: cookie.mgr, body: { name: uniq('Esc'), acl: [{ resource: 'asset.retire', operation: 'execute' }] } });
    expect(create.status).toBe(403);
    // 자기가 가진 역할에 권한을 추가해 스스로 권한을 키우는 것도 막힌다.
    const selfEsc = await call(withId(rolePatch, role.userMgr!), { method: 'PATCH', cookie: cookie.mgr, body: { acl: [...USER_ADMIN_ACL.map(([resource, operation]) => ({ resource, operation })), { resource: 'asset.retire', operation: 'execute' }] } });
    expect(selfEsc.status).toBe(403);
    expect((await call(withId(rolePatch, role['Stock Manager']!), { method: 'PATCH', cookie: cookie.mgr, body: { acl: [] } })).status).toBe(403);
    expect((await call(withId(roleDelete, role['Stock Manager']!), { method: 'DELETE', cookie: cookie.mgr })).status).toBe(403);
    const ok = await call(rolesCreate, { method: 'POST', cookie: cookie.mgr, body: { name: uniq('Small'), acl: [{ resource: 'dashboard', operation: 'read' }] } });
    expect(ok.status).toBe(201);
    const perms = await call(mePermissions, { cookie: cookie.mgr });
    expect(perms.data.permissions).not.toContain('asset.retire:execute');
  });
});

describe('부서 범위', () => {
  it('범위가 제한된 관리 담당은 범위 밖이나 전체 범위를 줄 수 없다', async () => {
    const mk = (departmentIds: string[]) => call(usersCreate, { method: 'POST', cookie: cookie.hrmgr, body: newUser({ roleIds: [role.deptReader], departmentIds }) });
    expect((await mk([])).status).toBe(403); // 빈 목록 = 전체 부서
    expect((await mk([dept.fin!])).status).toBe(403);
    expect((await mk([dept.hr!, dept.fin!])).status).toBe(403);
    expect((await mk([dept.hr!])).status).toBe(201);
  });

  it('범위가 제한된 관리 담당은 자기보다 범위가 넓은 계정을 관리할 수 없다', async () => {
    // reader 는 범위 제한이 없다(전체 부서).
    expect((await call(withId(userTempPassword, user.reader!), { method: 'POST', cookie: cookie.hrmgr })).status).toBe(403);
    expect((await call(withId(userPatch, user.reader!), { method: 'PATCH', cookie: cookie.hrmgr, body: { departmentIds: [dept.hr] } })).status).toBe(403);
  });

  it('역할만 바꾸는 요청은 부서 범위 검사에 걸리지 않는다', async () => {
    const created = await call(usersCreate, { method: 'POST', cookie: cookie.hrmgr, body: newUser({ roleIds: [role.deptReader], departmentIds: [dept.hr] }) });
    const r = await call(withId(userPatch, created.data.userId), { method: 'PATCH', cookie: cookie.hrmgr, body: { roleIds: [] } });
    expect(r.status).toBe(200);
    const scope = await row('SELECT count(*)::int AS n FROM app.user_department_scope WHERE user_id = $1', [created.data.userId]);
    expect(scope.n).toBe(1); // 범위는 그대로
  });

  it('내 권한 조회에 부서 범위가 나온다', async () => {
    const r = await call(mePermissions, { cookie: cookie.hrmgr });
    expect(r.data.departmentScope).toEqual([dept.hr]);
    expect(r.data.permissions).toContain('admin.user:create');
    expect((await call(mePermissions, { cookie: cookie.admin })).data).toMatchObject({ all: true, departmentScope: null });
    expect((await call(mePermissions, { cookie: cookie.plain })).data).toMatchObject({ all: false, permissions: [] });
  });
});

describe('다른 기업', () => {
  it('B 관리자는 A의 계정·역할을 ID로 지정해도 찾을 수 없다(404)이고, 아무것도 바뀌지 않는다', async () => {
    const before = await row('SELECT is_active, display_name FROM app.app_user WHERE id = $1', [user.reader]);
    expect((await call(withId(userPatch, user.reader!), { method: 'PATCH', cookie: cookie.badmin, body: { displayName: 'Hacked' } })).status).toBe(404);
    expect((await call(withId(userDeactivate, user.reader!), { method: 'POST', cookie: cookie.badmin })).status).toBe(404);
    expect((await call(withId(userTempPassword, user.reader!), { method: 'POST', cookie: cookie.badmin })).status).toBe(404);
    expect((await call(withId(rolePatch, role.userMgr!), { method: 'PATCH', cookie: cookie.badmin, body: { acl: [] } })).status).toBe(404);
    expect((await call(withId(roleDelete, role.deptReader!), { method: 'DELETE', cookie: cookie.badmin })).status).toBe(404);
    expect(await row('SELECT is_active, display_name FROM app.app_user WHERE id = $1', [user.reader])).toEqual(before);
    expect((await row('SELECT count(*)::int AS n FROM app.role_acl WHERE role_id = $1', [role.userMgr])).n).toBe(USER_ADMIN_ACL.length);
  });

  it('UUID 형식이 아닌 ID는 404', async () => {
    expect((await call(withId(userPatch, "1' OR '1'='1"), { method: 'PATCH', cookie: cookie.admin, body: { displayName: 'x' } })).status).toBe(404);
  });

  it('기업 문맥에서는 다른 기업 계정이나 시스템 관리자의 세션을 끊을 수 없다', async () => {
    const bSession = await sessionFor(B.code, 'buser');
    const rootSession = await sessionFor('OPERATOR', rootLogin);
    const rootId = (await row('SELECT id FROM app.app_user WHERE login_id = $1 AND company_id IS NULL', [rootLogin])).id;
    const n = await withTenant(A.id, async (db) => {
      const r1 = await db.query('SELECT app.revoke_user_sessions($1) AS n', [bUserId]);
      const r2 = await db.query('SELECT app.revoke_user_sessions($1) AS n', [rootId]);
      return [r1.rows[0]!.n, r2.rows[0]!.n];
    });
    expect(n).toEqual([0, 0]);
    expect((await call(meRoute, { cookie: bSession })).status).toBe(200);
    expect((await call(meRoute, { cookie: rootSession })).status).toBe(200);
  });
});

describe('계정 상태와 임시 비밀번호', () => {
  it('비활성화하면 그 계정의 세션이 즉시 끊기고, 다시 활성화하면 로그인된다', async () => {
    const id = uniq('toggle').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    const session = await sessionFor(A.code, id);
    expect((await call(withId(userDeactivate, userId), { method: 'POST', cookie: cookie.admin })).status).toBe(200);
    expect((await call(meRoute, { cookie: session })).status).toBe(401);
    expect((await row('SELECT count(*)::int AS n FROM app.user_session WHERE user_id = $1 AND revoked_at IS NULL', [userId])).n).toBe(0);
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(false);
    expect((await call(withId(userActivate, userId), { method: 'POST', cookie: cookie.admin })).status).toBe(200);
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(true);
  });

  it('임시 비밀번호를 발급하면 기존 세션과 옛 비밀번호가 무효가 되고, 감사 로그에 남는다', async () => {
    const id = uniq('reset').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    const session = await sessionFor(A.code, id);
    const r = await call(withId(userTempPassword, userId), { method: 'POST', cookie: cookie.admin });
    expect(r.status).toBe(200);
    expect((await call(meRoute, { cookie: session })).status).toBe(401);
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(false);
    const s = await login({ companyCode: A.code, loginId: id, password: r.data.tempPassword });
    expect(s.ok && s.user.mustChangePassword).toBe(true);
    const audit = await row("SELECT actor_id, coalesce(after::text, '') AS t FROM app.audit_log WHERE action = 'TEMP_PASSWORD_ISSUED' AND target_id = $1", [userId]);
    expect(audit.actor_id).toBe(user.admin);
    expect(audit.t).not.toContain(r.data.tempPassword);
  });

  it('잠긴 계정을 관리자가 풀 수 있다', async () => {
    const id = uniq('locked').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    for (let i = 0; i < 5; i += 1) await login({ companyCode: A.code, loginId: id, password: 'bad' });
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(false);
    expect((await call(withId(userUnlock, userId), { method: 'POST', cookie: cookie.admin })).status).toBe(200);
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(true);
  });

  it('두 관리자가 동시에 서로를 비활성화해도 관리자가 0명이 되지 않는다', async () => {
    const C = await makeCompany('ADMC');
    await makeUser(C.id, 'admin2', 'COMPANY_ADMIN');
    const admin2Id = (await row("SELECT id FROM app.app_user WHERE company_id = $1 AND login_id = 'admin2'", [C.id])).id;
    const [c1, c2] = [await sessionFor(C.code, 'admin'), await sessionFor(C.code, 'admin2')];
    const results = await Promise.all([
      call(withId(userDeactivate, admin2Id), { method: 'POST', cookie: c1 }),
      call(withId(userDeactivate, C.adminUserId), { method: 'POST', cookie: c2 }),
    ]);
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    const active = await row("SELECT count(*)::int AS n FROM app.app_user WHERE company_id = $1 AND user_type = 'COMPANY_ADMIN' AND is_active", [C.id]);
    expect(active.n).toBe(1);
  });

  it('일반 사용자를 관리자로 올리면 역할과 범위가 비워진다', async () => {
    const id = uniq('promo').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    await assign(A.id, userId, [role.Viewer!], [dept.hr!]);
    expect((await call(withId(userPatch, userId), { method: 'PATCH', cookie: cookie.admin, body: { userType: 'COMPANY_ADMIN' } })).status).toBe(200);
    expect((await row('SELECT (SELECT count(*) FROM app.user_role WHERE user_id = $1)::int + (SELECT count(*) FROM app.user_department_scope WHERE user_id = $1)::int AS n', [userId])).n).toBe(0);
  });
});

describe('역할 관리', () => {
  it('자기 기업의 역할만 나온다(시스템 템플릿·다른 기업 제외)', async () => {
    const r = await call(rolesList, { cookie: cookie.admin });
    const ids = r.data.roles.map((x: { id: string }) => x.id);
    expect(ids).toContain(role.Viewer);
    expect(ids).not.toContain(bRoleId);
    expect(ids).not.toContain('00000000-0000-4000-8000-000000000001');
    const res = await call(resourcesList, { cookie: cookie.admin });
    const item = res.data.resources.find((x: { code: string }) => x.code === 'asset.item');
    expect(item.operations).toEqual(['create', 'export', 'import', 'read', 'update']);
  });

  it('정의되지 않은 권한, system.* 리소스, 중복 이름은 거부된다', async () => {
    const mk = (body: unknown) => call(rolesCreate, { method: 'POST', cookie: cookie.admin, body });
    expect((await mk({ name: uniq('R'), acl: [{ resource: 'no.such', operation: 'read' }] })).status).toBe(400);
    expect((await mk({ name: uniq('R'), acl: [{ resource: 'asset.item', operation: 'delete' }] })).status).toBe(400); // 자산에는 delete 가 없다
    expect((await mk({ name: uniq('R'), acl: [{ resource: 'system.company', operation: 'create' }] })).status).toBe(400);
    expect((await mk({ name: 'viewer', acl: [] })).status).toBe(409);
  });

  it('역할을 만들고 고치면 권한이 즉시 반영된다', async () => {
    const id = uniq('roleuser').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    const session = await sessionFor(A.code, id);
    const created = await call(rolesCreate, { method: 'POST', cookie: cookie.admin, body: { name: uniq('Custom'), acl: [{ resource: 'admin.role', operation: 'read' }] } });
    expect(created.status).toBe(201);
    expect((await call(rolesList, { cookie: session })).status).toBe(403);
    expect((await call(withId(userPatch, userId), { method: 'PATCH', cookie: cookie.admin, body: { roleIds: [created.data.roleId] } })).status).toBe(200);
    expect((await call(rolesList, { cookie: session })).status).toBe(200);
    expect((await call(withId(rolePatch, created.data.roleId), { method: 'PATCH', cookie: cookie.admin, body: { acl: [] } })).status).toBe(200);
    expect((await call(rolesList, { cookie: session })).status).toBe(403);
    // 배정된 역할은 삭제할 수 없다.
    expect((await call(withId(roleDelete, created.data.roleId), { method: 'DELETE', cookie: cookie.admin })).status).toBe(409);
    await call(withId(userPatch, userId), { method: 'PATCH', cookie: cookie.admin, body: { roleIds: [] } });
    expect((await call(withId(roleDelete, created.data.roleId), { method: 'DELETE', cookie: cookie.admin })).status).toBe(200);
  });

  it('시스템 템플릿은 수정·삭제할 수 없다', async () => {
    const tpl = '00000000-0000-4000-8000-000000000003';
    expect((await call(withId(rolePatch, tpl), { method: 'PATCH', cookie: cookie.admin, body: { acl: [] } })).status).toBe(404);
    expect((await call(withId(roleDelete, tpl), { method: 'DELETE', cookie: cookie.admin })).status).toBe(404);
    expect((await row('SELECT count(*)::int AS n FROM app.role_acl WHERE role_id = $1', [tpl])).n).toBeGreaterThan(0);
  });
});

describe('시스템 관리자의 기업 선택', () => {
  it('기업을 고르기 전에는 기업 데이터에 접근할 수 없고, 고르면 그 기업만 보인다', async () => {
    const root = await sessionFor('OPERATOR', rootLogin);
    expect((await call(usersList, { cookie: root })).status).toBe(403);
    expect((await call(actingCompany, { method: 'POST', cookie: root, body: { companyId: A.id } })).status).toBe(200);
    const a = await call(usersList, { cookie: root });
    expect(a.status).toBe(200);
    expect(a.data.users.map((u: { id: string }) => u.id)).toContain(user.mgr);
    expect(a.data.users.map((u: { id: string }) => u.id)).not.toContain(bUserId);
    expect((await call(meRoute, { cookie: root })).data.user.actingCompanyId).toBe(A.id);

    await call(actingCompany, { method: 'POST', cookie: root, body: { companyId: B.id } });
    const b = await call(usersList, { cookie: root });
    expect(b.data.users.map((u: { id: string }) => u.id)).toContain(bUserId);
    expect(b.data.users.map((u: { id: string }) => u.id)).not.toContain(user.mgr);

    await call(actingCompany, { method: 'POST', cookie: root, body: { companyId: null } });
    expect((await call(usersList, { cookie: root })).status).toBe(403);
  });

  it('운영자의 접근은 그 기업의 감사 로그에 남는다', async () => {
    const root = await sessionFor('OPERATOR', rootLogin);
    await call(actingCompany, { method: 'POST', cookie: root, body: { companyId: A.id } });
    const seen = await withTenant(A.id, async (db) => (await db.query("SELECT 1 FROM app.audit_log WHERE action = 'SYSTEM_ADMIN_ENTERED'")).rowCount);
    expect(seen).toBeGreaterThan(0);
  });

  it('없는 기업·비활성 기업은 고를 수 없고, 고른 뒤 비활성화되면 접근이 끊긴다', async () => {
    const root = await sessionFor('OPERATOR', rootLogin);
    expect((await call(actingCompany, { method: 'POST', cookie: root, body: { companyId: '11111111-1111-4111-8111-111111111111' } })).status).toBe(404);
    const D = await makeCompany('ADMD');
    expect((await call(actingCompany, { method: 'POST', cookie: root, body: { companyId: D.id } })).status).toBe(200);
    expect((await call(usersList, { cookie: root })).status).toBe(200);
    await (await owner()).query('UPDATE app.company SET is_active = false WHERE id = $1', [D.id]);
    expect((await call(usersList, { cookie: root })).status).toBe(403);
    expect((await call(actingCompany, { method: 'POST', cookie: root, body: { companyId: D.id } })).status).toBe(404);
  });

  it('기업 계정은 기업을 고를 수 없고, 헤더·본문으로 다른 기업을 지정해도 무시된다', async () => {
    expect((await call(actingCompany, { method: 'POST', cookie: cookie.admin, body: { companyId: B.id } })).status).toBe(403);
    const r = await call(usersList, { cookie: cookie.admin, path: `/api/admin/users?companyId=${B.id}`, headers: { 'x-company-id': B.id } });
    expect(r.data.users.map((u: { id: string }) => u.id)).not.toContain(bUserId);
  });

  it('시스템 관리자는 고른 기업 안에서 관리자 계정을 만들 수 있다', async () => {
    const root = await sessionFor('OPERATOR', rootLogin);
    await call(actingCompany, { method: 'POST', cookie: root, body: { companyId: B.id } });
    const body = newUser({ userType: 'COMPANY_ADMIN' });
    const r = await call(usersCreate, { method: 'POST', cookie: root, body });
    expect(r.status).toBe(201);
    expect((await row('SELECT company_id FROM app.app_user WHERE id = $1', [r.data.userId])).company_id).toBe(B.id);
    const l = await call(loginRoute, { method: 'POST', body: { companyCode: B.code, loginId: body.loginId, password: r.data.tempPassword } });
    expect(l.status).toBe(200);
  });
});
