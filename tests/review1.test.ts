// 1단계 독립 검토에서 재현된 문제와, 변이 시험에서 테스트가 잡지 못했던 검사들.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PATCH as rolePatch } from '@/app/api/admin/roles/[id]/route';
import { POST as rolesCreate } from '@/app/api/admin/roles/route';
import { POST as userDeactivate } from '@/app/api/admin/users/[id]/deactivate/route';
import { PATCH as userPatch } from '@/app/api/admin/users/[id]/route';
import { POST as userTempPassword } from '@/app/api/admin/users/[id]/temp-password/route';
import { GET as usersList, POST as usersCreate } from '@/app/api/admin/users/route';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { GET as mePermissions } from '@/app/api/me/permissions/route';
import { POST as actingCompany } from '@/app/api/system/acting-company/route';
import { setUserActive } from '@/lib/admin/users';
import { IP_FAIL_LIMIT, login } from '@/lib/auth/login';
import { withTenant } from '@/lib/db/context';
import { assertSafeRole, closePool, UnsafeDbRoleError } from '@/lib/db/pool';
import { HttpError } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { call, closeOwner, GOOD_PASSWORD, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
const role: Record<string, string> = {};
const dept: Record<string, string> = {};

type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
const withId = (h: Handler, id: string) => (req: Request) => h(req, { params: Promise.resolve({ id }) });
const row = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];

async function makeRole(name: string, acl: Array<[string, string]>, active = true): Promise<string> {
  const o = await owner();
  const r = await o.query('INSERT INTO app.role (company_id, name, is_active) VALUES ($1, $2, $3) RETURNING id', [A.id, name, active]);
  for (const [res, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [r.rows[0].id, res, op]);
  return r.rows[0].id;
}
async function userWith(prefix: string, roleIds: string[]): Promise<{ id: string; loginId: string; cookie: string }> {
  const loginId = uniq(prefix).toLowerCase();
  const id = await makeUser(A.id, loginId, 'COMPANY_USER');
  const o = await owner();
  for (const r of roleIds) await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [id, r, A.id]);
  return { id, loginId, cookie: await sessionFor(A.code, loginId) };
}

const MANAGE: Array<[string, string]> = [
  ['admin.user', 'read'], ['admin.user', 'create'], ['admin.user', 'update'], ['admin.user', 'activate'], ['admin.user', 'deactivate'],
  ['admin.user.password', 'execute'], ['admin.role', 'read'], ['admin.role', 'create'], ['admin.role', 'update'],
];

beforeAll(async () => {
  A = await makeCompany('REVA');
  role.helpdesk = await makeRole('Helpdesk', [['admin.user.password', 'execute'], ['admin.user', 'read']]);
  role.manage = await makeRole('Manage', MANAGE);
  role.big = await makeRole('Big', [['asset.retire', 'execute'], ['admin.user', 'create'], ['history.audit', 'read']]);
  role.small = await makeRole('Small', [['admin.user', 'read']]);
  const o = await owner();
  dept.old = (await o.query("INSERT INTO app.department (company_id, name, is_active) VALUES ($1, 'Closed', false) RETURNING id", [A.id])).rows[0].id;
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('꺼진 역할을 이용한 계정 탈취 (검토 HIGH-1)', () => {
  it('큰 역할이 잠시 꺼져 있는 계정도, 그 역할만큼 권한이 큰 계정으로 본다', async () => {
    const hd = await userWith('hd', [role.helpdesk!]);
    const target = await userWith('big', [role.big!]);
    const admin = await sessionFor(A.code, 'admin');
    // 관리자가 Big 역할을 잠시 끈다. 대상은 지금 당장은 아무 권한이 없어 보인다.
    expect((await call(withId(rolePatch, role.big!), { method: 'PATCH', cookie: admin, body: { isActive: false } })).status).toBe(200);
    // 헬프데스크가 그 계정의 임시 비밀번호를 받으려 한다 → 거부되어야 한다.
    const r = await call(withId(userTempPassword, target.id), { method: 'POST', cookie: hd.cookie });
    expect(r.status).toBe(403);
    expect(r.data.tempPassword).toBeUndefined();
    expect((await call(withId(userDeactivate, target.id), { method: 'POST', cookie: hd.cookie })).status).toBe(403);
    // 대상 계정의 비밀번호는 그대로다.
    expect((await login({ companyCode: A.code, loginId: target.loginId, password: GOOD_PASSWORD })).ok).toBe(true);
    await call(withId(rolePatch, role.big!), { method: 'PATCH', cookie: admin, body: { isActive: true } });
    // 역할이 작은 계정은 정상적으로 처리된다(검사가 전부를 막고 있는 것이 아님을 확인).
    const smallTarget = await userWith('sm', [role.small!]);
    expect((await call(withId(userTempPassword, smallTarget.id), { method: 'POST', cookie: hd.cookie })).status).toBe(200);
  });

  it('요청자 자신의 권한은 켜져 있는 역할만으로 계산한다', async () => {
    const offBig = await makeRole(uniq('OffBig'), [['asset.retire', 'execute']], false);
    const mgr = await userWith('mgr', [role.manage!, offBig]);
    // 꺼진 역할의 권한을 근거로 남에게 줄 수 없다.
    const r = await call(rolesCreate, { method: 'POST', cookie: mgr.cookie, body: { name: uniq('Leak'), acl: [{ resource: 'asset.retire', operation: 'execute' }] } });
    expect(r.status).toBe(403);
    expect((await call(mePermissions, { cookie: mgr.cookie })).data.permissions).not.toContain('asset.retire:execute');
  });
});

describe('변이 시험에서 잡히지 않던 검사', () => {
  it('관리 권한을 받은 일반 사용자는 누구도 기업 관리자로 올릴 수 없다', async () => {
    const mgr = await userWith('mgr', [role.manage!]);
    const target = await userWith('tgt', [role.small!]);
    const r = await call(withId(userPatch, target.id), { method: 'PATCH', cookie: mgr.cookie, body: { userType: 'COMPANY_ADMIN' } });
    expect(r.status).toBe(403);
    expect((await row('SELECT user_type FROM app.app_user WHERE id = $1', [target.id])).user_type).toBe('COMPANY_USER');
  });

  it('꺼진 역할과 비활성 부서는 배정할 수 없다', async () => {
    const admin = await sessionFor(A.code, 'admin');
    const off = await makeRole(uniq('Off'), [['dashboard', 'read']], false);
    const mk = (over: Record<string, unknown>) =>
      call(usersCreate, { method: 'POST', cookie: admin, body: { loginId: uniq('n').toLowerCase(), displayName: 'N', userType: 'COMPANY_USER', roleIds: [], departmentIds: [], ...over } });
    expect((await mk({ roleIds: [off] })).status).toBe(400);
    expect((await mk({ departmentIds: [dept.old] })).status).toBe(400);
    expect((await mk({})).status).toBe(201);
  });

  it('자기 계정의 임시 비밀번호는 발급할 수 없다', async () => {
    const admin = await sessionFor(A.code, 'admin');
    expect((await call(withId(userTempPassword, A.adminUserId), { method: 'POST', cookie: admin })).status).toBe(403);
    expect((await login({ companyCode: A.code, loginId: 'admin', password: GOOD_PASSWORD })).ok).toBe(true);
  });

  it('두 관리자가 정말로 동시에 서로를 비활성화해도: 한쪽만 성공하고, 다른 쪽은 "마지막 관리자"로 거부되며, 오류(교착)가 없다', async () => {
    // API를 거치면 먼저 끝난 쪽이 상대의 세션을 끊어 버려 경쟁이 성립하지 않는다.
    // 그래서 권한 판정 뒤의 변경 함수를 두 트랜잭션에서 직접 동시에 호출한다.
    for (let round = 0; round < 8; round += 1) {
      const C = await makeCompany('RACE');
      const second = await makeUser(C.id, 'admin2', 'COMPANY_ADMIN');
      const actor = (userId: string): Actor => ({ userId, userType: 'COMPANY_ADMIN', companyId: C.id, isAdmin: true, auditIp: null });
      const results = await Promise.allSettled([
        withTenant(C.id, (db) => setUserActive(db, actor(C.adminUserId), second, false, null)),
        withTenant(C.id, (db) => setUserActive(db, actor(second), C.adminUserId, false, null)),
      ]);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
      expect(results.filter((r) => r.status === 'fulfilled').length, `round ${round}`).toBe(1);
      expect(failures.length).toBe(1);
      expect(failures[0]).toBeInstanceOf(HttpError); // 교착(40P01) 같은 DB 오류가 아니다
      expect((failures[0] as HttpError).code).toBe('LAST_ADMIN');
      const n = await row("SELECT count(*)::int AS n FROM app.app_user WHERE company_id = $1 AND user_type = 'COMPANY_ADMIN' AND is_active", [C.id]);
      expect(n.n).toBe(1);
    }
  });

  it('같은 로그인 ID·역할 이름을 동시에 만들어도 500이 나지 않는다', async () => {
    const admin = await sessionFor(A.code, 'admin');
    const loginId = uniq('dup').toLowerCase();
    const users = await Promise.all(Array.from({ length: 4 }, () =>
      call(usersCreate, { method: 'POST', cookie: admin, body: { loginId, displayName: 'D', userType: 'COMPANY_USER', roleIds: [], departmentIds: [] } })));
    expect(users.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    const name = uniq('DupRole');
    const roles = await Promise.all(Array.from({ length: 4 }, () => call(rolesCreate, { method: 'POST', cookie: admin, body: { name, acl: [] } })));
    expect(roles.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });
});

describe('IP 제한', () => {
  it('요청을 한꺼번에 보내도 한도를 넘는 시도는 처리되지 않는다', async () => {
    const ip = '203.0.113.150';
    const attempts = await Promise.all(Array.from({ length: IP_FAIL_LIMIT * 2 }, (_, i) =>
      call(loginRoute, { method: 'POST', headers: { 'x-test-client-ip': ip }, body: { companyCode: 'NOSUCHCO', loginId: `p${i}`, password: 'bad' } })));
    const recorded = await row("SELECT count(*)::int AS n FROM app.audit_log WHERE action = 'LOGIN_FAILED' AND ip = $1", [ip]);
    expect(recorded.n).toBe(IP_FAIL_LIMIT);
    expect(attempts.filter((r) => r.status === 429).length).toBe(IP_FAIL_LIMIT);
    // 한도를 넘은 뒤에는 맞는 비밀번호도 결과를 알려주지 않는다.
    const good = await call(loginRoute, { method: 'POST', headers: { 'x-test-client-ip': ip }, body: { companyCode: A.code, loginId: 'admin', password: GOOD_PASSWORD } });
    expect(good.status).toBe(429);
  });
});

describe('시스템 관리자', () => {
  it('다른 탭에서 기업을 바꾼 뒤, 이전 기업을 보고 있던 화면의 요청은 거부된다', async () => {
    const B = await makeCompany('REVB');
    const rootLogin = uniq('root').toLowerCase();
    await makeUser(null, rootLogin, 'SYSTEM_ADMIN');
    const root = await sessionFor('OPERATOR', rootLogin);
    await call(actingCompany, { method: 'POST', cookie: root, body: { companyId: A.id } }); // 탭 1: A 선택
    await call(actingCompany, { method: 'POST', cookie: root, body: { companyId: B.id } }); // 탭 2: B 선택
    const body = { loginId: uniq('x').toLowerCase(), displayName: 'X', userType: 'COMPANY_USER', roleIds: [], departmentIds: [] };
    // 탭 1(화면은 아직 A)에서 사용자 생성 → 거부, 어느 기업에도 만들어지지 않는다.
    const stale = await call(usersCreate, { method: 'POST', cookie: root, headers: { 'x-expected-company': A.id }, body });
    expect(stale.status).toBe(409);
    expect(stale.data.error.code).toBe('COMPANY_CHANGED');
    expect(await row('SELECT 1 AS x FROM app.app_user WHERE login_id = $1', [body.loginId])).toBeUndefined();
    // 화면과 세션이 일치하면 정상 처리된다.
    expect((await call(usersCreate, { method: 'POST', cookie: root, headers: { 'x-expected-company': B.id }, body })).status).toBe(201);
    // 헤더로 기업을 "지정"할 수는 없다: 기업 계정이 다른 기업 ID를 보내면 거부될 뿐이다.
    const admin = await sessionFor(A.code, 'admin');
    expect((await call(usersList, { cookie: admin, headers: { 'x-expected-company': B.id } })).status).toBe(409);
  });

  it('기업의 감사 로그에는 운영자의 접근 사실만 남고, 운영자의 IP와 로그인 ID는 남지 않는다', async () => {
    const rootLogin = uniq('root').toLowerCase();
    await makeUser(null, rootLogin, 'SYSTEM_ADMIN');
    const login1 = await call(loginRoute, { method: 'POST', headers: { 'x-test-client-ip': '198.51.100.44' }, body: { companyCode: 'OPERATOR', loginId: rootLogin, password: GOOD_PASSWORD } });
    const root = (login1.setCookie ?? '').split(';')[0]!;
    const C = await makeCompany('REVC');
    const h = { 'x-test-client-ip': '198.51.100.44' };
    await call(actingCompany, { method: 'POST', cookie: root, headers: h, body: { companyId: C.id } });
    await call(usersCreate, { method: 'POST', cookie: root, headers: h, body: { loginId: 'made.by.root', displayName: 'R', userType: 'COMPANY_USER', roleIds: [], departmentIds: [] } });
    const o = await owner();
    const tenantRows = await o.query("SELECT action, ip, coalesce(before::text, '') || coalesce(after::text, '') AS t FROM app.audit_log WHERE company_id = $1", [C.id]);
    expect(tenantRows.rows.map((r) => r.action).sort()).toEqual(['SYSTEM_ADMIN_ENTERED', 'USER_CREATED']);
    for (const r of tenantRows.rows) {
      expect(r.ip).toBeNull();
      expect(r.t).not.toContain(rootLogin);
    }
    // 시스템 감사 로그에는 누가 어디서 들어갔는지 남는다.
    const sys = await o.query("SELECT ip FROM app.audit_log WHERE company_id IS NULL AND action = 'SYSTEM_ADMIN_ENTERED' AND target_id = $1", [C.id]);
    expect(sys.rows).toEqual([{ ip: '198.51.100.44' }]);
  });
});

describe('DB 역할 안전 검사', () => {
  /** 임시 역할을 만들어 그 역할로 검사를 돌린다. 끝나면 전부 되돌린다. */
  async function checkAs(setup: string[]): Promise<'safe' | 'unsafe'> {
    const c = new pg.Client({ connectionString: process.env.TEST_OWNER_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('CREATE ROLE zz_probe NOLOGIN');
      await c.query('GRANT USAGE ON SCHEMA app TO zz_probe');
      for (const sql of setup) await c.query(sql);
      await c.query('SET LOCAL ROLE zz_probe');
      try {
        await assertSafeRole(c);
        return 'safe';
      } catch (err) {
        if (err instanceof UnsafeDbRoleError) return 'unsafe';
        throw err;
      }
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  it('평범한 역할은 통과한다', async () => {
    expect(await checkAs([])).toBe('safe');
  });
  it('BYPASSRLS 역할은 거부된다', async () => {
    expect(await checkAs(['ALTER ROLE zz_probe BYPASSRLS'])).toBe('unsafe');
  });
  it('테이블을 소유한(슈퍼유저가 아닌) 역할은 거부된다', async () => {
    expect(await checkAs(['ALTER TABLE app.notification OWNER TO zz_probe'])).toBe('unsafe');
  });
  it('모든 테이블을 읽고 쓰는 내장 역할의 구성원은 거부된다', async () => {
    expect(await checkAs(['GRANT pg_read_all_data TO zz_probe'])).toBe('unsafe');
    expect(await checkAs(['GRANT pg_write_all_data TO zz_probe'])).toBe('unsafe');
  });
  it('BYPASSRLS 역할의 구성원은 상속하지 않아도 거부된다', async () => {
    expect(await checkAs(['CREATE ROLE zz_bypass NOLOGIN BYPASSRLS', 'GRANT zz_bypass TO zz_probe WITH INHERIT FALSE'])).toBe('unsafe');
  });
});
