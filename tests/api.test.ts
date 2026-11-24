// API 수준 검증: 실제 라우트 핸들러를 호출한다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { POST as logoutRoute } from '@/app/api/auth/logout/route';
import { POST as changePasswordRoute } from '@/app/api/auth/change-password/route';
import { GET as meRoute } from '@/app/api/me/route';
import { GET as departmentsRoute } from '@/app/api/departments/route';
import { GET as companiesList, POST as companiesCreate } from '@/app/api/system/companies/route';
import { closePool } from '@/lib/db/pool';
import { call, closeOwner, GOOD_PASSWORD, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
let rootId: string;

beforeAll(async () => {
  A = await makeCompany('APIA');
  B = await makeCompany('APIB');
  rootId = uniq('root').toLowerCase();
  await makeUser(null, rootId, 'SYSTEM_ADMIN');
  const o = await owner();
  await o.query("INSERT INTO app.department (company_id, name) VALUES ($1, 'Finance-A'), ($2, 'Secret-B')", [A.id, B.id]);
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

const cookieOf = (setCookie: string | null) => (setCookie ?? '').split(';')[0]!;

describe('로그인 API', () => {
  it('성공하면 HttpOnly·SameSite 쿠키를 내려주고, 응답 본문에 토큰을 싣지 않는다', async () => {
    const r = await call(loginRoute, { method: 'POST', body: { companyCode: A.code, loginId: 'admin', password: GOOD_PASSWORD } });
    expect(r.status).toBe(200);
    expect(r.setCookie).toMatch(/^sm_session=/);
    expect(r.setCookie).toMatch(/HttpOnly/);
    expect(r.setCookie).toMatch(/SameSite=Lax/);
    expect(JSON.stringify(r.data)).not.toContain(cookieOf(r.setCookie).split('=')[1]);
    const me = await call(meRoute, { cookie: cookieOf(r.setCookie) });
    expect(me.data.user).toMatchObject({ loginId: 'admin', userType: 'COMPANY_ADMIN', companyId: A.id });
  });

  it('실패 응답은 원인을 구분하지 않는다', async () => {
    const wrongPw = await call(loginRoute, { method: 'POST', body: { companyCode: A.code, loginId: 'admin', password: 'nope' } });
    const noUser = await call(loginRoute, { method: 'POST', body: { companyCode: A.code, loginId: 'ghost', password: 'nope' } });
    const noCo = await call(loginRoute, { method: 'POST', body: { companyCode: 'GHOSTCO', loginId: 'admin', password: 'nope' } });
    for (const r of [wrongPw, noUser, noCo]) {
      expect(r.status).toBe(401);
      expect(r.data).toEqual(wrongPw.data);
      expect(r.setCookie).toBeNull();
    }
  });

  it('본문 형식이 틀리면 400', async () => {
    const r = await call(loginRoute, { method: 'POST', body: { companyCode: A.code } });
    expect(r.status).toBe(400);
  });
});

describe('접근 통제', () => {
  it('로그인하지 않으면 401', async () => {
    for (const h of [meRoute, departmentsRoute, companiesList]) expect((await call(h)).status).toBe(401);
    expect((await call(logoutRoute, { method: 'POST' })).status).toBe(401);
    expect((await call(departmentsRoute, { cookie: 'sm_session=forged-token-value-1234567890' })).status).toBe(401);
  });

  it('기업 A 계정은 A의 부서만 본다(B의 데이터는 응답에 없다)', async () => {
    const cookie = await sessionFor(A.code, 'admin');
    const r = await call(departmentsRoute, { cookie });
    expect(r.status).toBe(200);
    const names = r.data.departments.map((d: { name: string }) => d.name);
    expect(names).toContain('Finance-A');
    expect(names).not.toContain('Secret-B');
  });

  it('요청에 다른 기업 ID를 실어 보내도 무시된다', async () => {
    const cookie = await sessionFor(A.code, 'admin');
    const r = await call(departmentsRoute, {
      cookie,
      path: `/api/departments?company_id=${B.id}&companyId=${B.id}`,
      headers: { 'x-company-id': B.id },
    });
    expect(r.data.departments.map((d: { name: string }) => d.name)).not.toContain('Secret-B');
  });

  it('역할이 없는 기업 사용자는 403, 조회 역할을 받으면 200, 역할이 비활성화되면 다시 403', async () => {
    const id = uniq('viewer').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    const cookie = await sessionFor(A.code, id);
    expect((await call(departmentsRoute, { cookie })).status).toBe(403);

    const o = await owner();
    const role = (await o.query("SELECT id FROM app.role WHERE company_id = $1 AND name = 'Viewer'", [A.id])).rows[0].id;
    await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [userId, role, A.id]);
    expect((await call(departmentsRoute, { cookie })).status).toBe(200);

    await o.query('UPDATE app.role SET is_active = false WHERE id = $1', [role]);
    expect((await call(departmentsRoute, { cookie })).status).toBe(403);
    await o.query('UPDATE app.role SET is_active = true WHERE id = $1', [role]);
  });

  it('시스템 전용 API는 기업 관리자도 호출할 수 없다', async () => {
    const cookie = await sessionFor(A.code, 'admin');
    expect((await call(companiesList, { cookie })).status).toBe(403);
    const r = await call(companiesCreate, {
      method: 'POST',
      cookie,
      body: { code: uniq('EVIL'), name: 'Evil', admin: { loginId: 'admin', displayName: 'x' } },
    });
    expect(r.status).toBe(403);
  });

  it('시스템 관리자는 기업을 만들 수 있고, 만들어진 기업에는 IT 부서와 역할 3개가 있다', async () => {
    const cookie = await sessionFor('OPERATOR', rootId);
    const code = uniq('NEW');
    const r = await call(companiesCreate, {
      method: 'POST',
      cookie,
      body: { code, name: 'New Co', admin: { loginId: 'first.admin', displayName: 'First Admin' } },
    });
    expect(r.status).toBe(201);
    expect(typeof r.data.tempPassword).toBe('string');
    const o = await owner();
    const dept = await o.query('SELECT name, is_default FROM app.department WHERE company_id = $1', [r.data.companyId]);
    expect(dept.rows).toEqual([{ name: 'IT', is_default: true }]);
    const roles = await o.query('SELECT count(*)::int AS n FROM app.role WHERE company_id = $1', [r.data.companyId]);
    const acl = await o.query('SELECT count(*)::int AS n FROM app.role_acl a JOIN app.role r ON r.id = a.role_id WHERE r.company_id = $1', [r.data.companyId]);
    const tpl = await o.query('SELECT count(*)::int AS n FROM app.role_acl a JOIN app.role r ON r.id = a.role_id WHERE r.company_id IS NULL');
    expect(roles.rows[0].n).toBe(3);
    expect(acl.rows[0].n).toBe(tpl.rows[0].n);

    // 같은 코드로 다시 만들면 409
    const dup = await call(companiesCreate, { method: 'POST', cookie, body: { code, name: 'Dup', admin: { loginId: 'a.b', displayName: 'x' } } });
    expect(dup.status).toBe(409);
  });

  it('임시 비밀번호 상태에서는 업무 API가 막히고, 변경 후에 열린다', async () => {
    const root = await sessionFor('OPERATOR', rootId);
    const code = uniq('PWD');
    const created = await call(companiesCreate, { method: 'POST', cookie: root, body: { code, name: 'Pwd Co', admin: { loginId: 'boss', displayName: 'Boss' } } });
    const loginRes = await call(loginRoute, { method: 'POST', body: { companyCode: code, loginId: 'boss', password: created.data.tempPassword } });
    const cookie = cookieOf(loginRes.setCookie);
    expect(loginRes.data.user.mustChangePassword).toBe(true);

    const blocked = await call(departmentsRoute, { cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.data.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await call(meRoute, { cookie })).status).toBe(200); // 내 정보와 비밀번호 변경은 허용

    const changed = await call(changePasswordRoute, { method: 'POST', cookie, body: { currentPassword: created.data.tempPassword, newPassword: 'After-Change-123' } });
    expect(changed.status).toBe(200);
    expect((await call(departmentsRoute, { cookie })).status).toBe(401); // 옛 세션은 끊겼다
    expect((await call(departmentsRoute, { cookie: cookieOf(changed.setCookie) })).status).toBe(200);
  });

  it('로그아웃하면 그 쿠키로 더 이상 접근할 수 없다', async () => {
    const cookie = await sessionFor(A.code, 'admin');
    const out = await call(logoutRoute, { method: 'POST', cookie });
    expect(out.status).toBe(200);
    expect(out.setCookie).toMatch(/Max-Age=0/);
    expect((await call(meRoute, { cookie })).status).toBe(401);
  });
});

describe('CSRF', () => {
  it('다른 사이트에서 온 상태 변경 요청은 거부된다', async () => {
    const cookie = await sessionFor(A.code, 'admin');
    const foreign = await call(logoutRoute, { method: 'POST', cookie, headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    const crossSite = await call(logoutRoute, { method: 'POST', cookie, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    // 거부된 요청은 실제로 아무것도 바꾸지 않았다.
    expect((await call(meRoute, { cookie })).status).toBe(200);
  });
});

describe('오류 응답', () => {
  it('내부 오류 내용은 응답에 노출되지 않는다', async () => {
    const cookie = await sessionFor('OPERATOR', rootId);
    // 형식 검사는 통과하지만 DB 제약(시간대 길이 등)과 무관한 정상 요청 → 201 이어야 하고,
    // 스택이나 SQL 문구가 본문에 없어야 한다.
    const r = await call(companiesCreate, { method: 'POST', cookie, body: { code: uniq('ERR'), name: 'Err', admin: { loginId: 'adm', displayName: 'x' } } });
    expect(JSON.stringify(r.data)).not.toMatch(/app\.|INSERT|stack|at \w+ \(/);
  });
});
