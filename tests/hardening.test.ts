// 독립 보안 검토에서 재현된 문제들이 다시 생기지 않는지 확인한다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as changePasswordRoute } from '@/app/api/auth/change-password/route';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { GET as meRoute } from '@/app/api/me/route';
import { GET as companiesList, POST as companiesCreate } from '@/app/api/system/companies/route';
import { IP_FAIL_LIMIT, login, MAX_FAILED_LOGINS } from '@/lib/auth/login';
import { resolveSession } from '@/lib/auth/session';
import { closePool } from '@/lib/db/pool';
import { clearSessionCookie, sessionCookie, sessionCookieName } from '@/lib/http/cookies';
import { clientIp, route } from '@/lib/http/route';
import { call, closeOwner, GOOD_PASSWORD, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;

beforeAll(async () => {
  A = await makeCompany('HRDA');
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

const cookieOf = (setCookie: string | null) => (setCookie ?? '').split(';')[0]!;
const req = (headers: Record<string, string>) => new Request('http://app.test/', { headers });

describe('접속자 IP', () => {
  it('클라이언트가 보낸 x-forwarded-for, x-real-ip 는 믿지 않는다', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4' }))).toBeNull();
  });

  it('신뢰하도록 설정한 헤더에서만 읽고, 목록이면 마지막(가장 가까운 프록시가 붙인) 값을 쓴다', () => {
    expect(clientIp(req({ 'x-test-client-ip': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(req({ 'x-test-client-ip': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(req({ 'x-test-client-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('IP 형식이 아닌 값과 지나치게 긴 값은 버린다', () => {
    expect(clientIp(req({ 'x-test-client-ip': '<script>alert(1)</script>' }))).toBeNull();
    expect(clientIp(req({ 'x-test-client-ip': '1'.repeat(500) }))).toBeNull();
  });

  it('위조한 x-forwarded-for 로는 IP 제한을 피하지도, 남의 로그인을 막지도 못한다', async () => {
    // 공격자가 피해자의 IP를 사칭해 실패를 쌓는다.
    for (let i = 0; i < IP_FAIL_LIMIT + 5; i += 1) {
      await call(loginRoute, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' }, body: { companyCode: 'NOPE', loginId: `x${i}`, password: 'bad' } });
    }
    // 피해자는 실제 IP(신뢰 헤더)로 정상 로그인된다.
    const victim = await call(loginRoute, { method: 'POST', headers: { 'x-test-client-ip': '198.51.100.7' }, body: { companyCode: A.code, loginId: 'admin', password: GOOD_PASSWORD } });
    expect(victim.status).toBe(200);
    // 위조 IP는 어디에도 저장되지 않았다.
    const o = await owner();
    expect((await o.query("SELECT 1 FROM app.audit_log WHERE ip = '198.51.100.7' AND action = 'LOGIN_FAILED'")).rowCount).toBe(0);
  });
});

describe('잠금', () => {
  it('동시에 틀린 비밀번호를 여러 번 보내도 정확히 한도에서 잠긴다', async () => {
    const id = uniq('race').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    const results = await Promise.all(Array.from({ length: 20 }, () => login({ companyCode: A.code, loginId: id, password: 'bad-guess' })));
    expect(results.every((r) => !r.ok)).toBe(true);
    const o = await owner();
    const details = await o.query("SELECT after->>'detail' AS d, count(*)::int AS n FROM app.audit_log WHERE actor_id = $1 AND action = 'LOGIN_FAILED' GROUP BY 1", [userId]);
    const by = Object.fromEntries(details.rows.map((r) => [r.d, r.n]));
    expect(by.bad_password).toBe(MAX_FAILED_LOGINS - 1);
    expect(by.bad_password_locked).toBe(1);
    expect(by.locked).toBe(20 - MAX_FAILED_LOGINS);
    expect(await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).toEqual({ ok: false, reason: 'LOCKED' });
  });

  it('잠기기 직전에 시작된 맞는 비밀번호 시도도, 그 사이 잠겼다면 거부된다', async () => {
    const id = uniq('race2').toLowerCase();
    await makeUser(A.id, id, 'COMPANY_USER');
    const attempts = [
      ...Array.from({ length: MAX_FAILED_LOGINS }, () => login({ companyCode: A.code, loginId: id, password: 'bad-guess' })),
    ];
    await Promise.all(attempts);
    const after = await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD });
    expect(after.ok).toBe(false);
  });

  it('비밀번호 변경 화면에서 현재 비밀번호를 계속 틀리면 잠기고 세션이 끊기며, 감사 로그에 남는다', async () => {
    const id = uniq('guess').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    const cookie = await sessionFor(A.code, id);
    for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) {
      const r = await call(changePasswordRoute, { method: 'POST', cookie, body: { currentPassword: `guess-${i}`, newPassword: 'Brand-New-Pass-88' } });
      expect(r.status).toBe(400);
    }
    const o = await owner();
    expect((await o.query('SELECT locked_until > now() AS locked FROM app.app_user WHERE id = $1', [userId])).rows[0].locked).toBe(true);
    expect((await o.query("SELECT count(*)::int AS n FROM app.audit_log WHERE actor_id = $1 AND action = 'PASSWORD_CHANGE_FAILED'", [userId])).rows[0].n).toBe(MAX_FAILED_LOGINS);
    // 세션이 끊겼다.
    expect((await call(meRoute, { cookie })).status).toBe(401);
    // 비밀번호는 바뀌지 않았다.
    await o.query('UPDATE app.app_user SET locked_until = NULL WHERE id = $1', [userId]);
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(true);
  });
});

describe('로그인 폭주', () => {
  it('로그인 시도가 몰려도 DB 연결이 바닥나지 않고, 로그인한 사용자의 요청은 정상 처리된다', async () => {
    const s = await login({ companyCode: A.code, loginId: 'admin', password: GOOD_PASSWORD });
    if (!s.ok) throw new Error('login');
    const flood = Array.from({ length: 300 }, (_, i) => login({ companyCode: 'NOSUCHCO', loginId: `flood${i}`, password: 'bad' }));
    // 폭주가 진행되는 동안 기존 사용자의 세션 확인 시간을 잰다.
    const started = Date.now();
    const user = await resolveSession(s.token);
    const elapsed = Date.now() - started;
    const results = await Promise.allSettled(flood);
    expect(user).not.toBeNull();
    expect(elapsed).toBeLessThan(2000);
    // 예외(연결 풀 시간 초과 등)로 끝난 시도가 없어야 한다. 초과분은 '잠시 후 다시'로 거절된다.
    expect(results.filter((r) => r.status === 'rejected').length).toBe(0);
    const reasons = results.map((r) => (r.status === 'fulfilled' && !r.value.ok ? r.value.reason : 'other'));
    expect(reasons.filter((r) => r === 'RATE_LIMITED').length).toBeGreaterThan(0);
    expect(reasons.every((r) => r === 'RATE_LIMITED' || r === 'INVALID')).toBe(true);
  });
});

describe('접근 통제 보강', () => {
  it('임시 비밀번호 상태의 시스템 관리자는 시스템 API를 호출할 수 없다', async () => {
    const id = uniq('tmproot').toLowerCase();
    await makeUser(null, id, 'SYSTEM_ADMIN', { mustChange: true });
    const cookie = await sessionFor('OPERATOR', id);
    const list = await call(companiesList, { cookie });
    expect(list.status).toBe(403);
    expect(list.data.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const create = await call(companiesCreate, { method: 'POST', cookie, body: { code: uniq('BLK'), name: 'x', admin: { loginId: 'adm', displayName: 'x' } } });
    expect(create.status).toBe(403);
    expect(create.data.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('깨진 쿠키 값은 500이 아니라 로그인 안 된 것으로 처리된다', async () => {
    const r = await call(meRoute, { cookie: `${sessionCookieName()}=%E0%A4%A` });
    expect(r.status).toBe(401);
  });

  it('처리 중 예외가 나면 500과 고정 문구만 내려가고, 내부 내용은 응답에 없다', async () => {
    const boom = route({ access: 'public' }, async () => {
      throw new Error('relation "app.secret_table" does not exist at /srv/app/src/lib/x.ts:42');
    });
    const original = console.error;
    console.error = () => undefined;
    try {
      const r = await call(boom);
      expect(r.status).toBe(500);
      expect(r.data).toEqual({ error: { code: 'INTERNAL', message: '서버 오류가 발생했습니다.' } });
    } finally {
      console.error = original;
    }
  });

  it('없는 시간대로는 기업을 만들 수 없다', async () => {
    const id = uniq('tzroot').toLowerCase();
    await makeUser(null, id, 'SYSTEM_ADMIN');
    const cookie = await sessionFor('OPERATOR', id);
    const bad = await call(companiesCreate, { method: 'POST', cookie, body: { code: uniq('TZ'), name: 'x', timezone: 'Mars/Olympus', admin: { loginId: 'adm', displayName: 'x' } } });
    expect(bad.status).toBe(400);
    const good = await call(companiesCreate, { method: 'POST', cookie, body: { code: uniq('TZ'), name: 'x', timezone: 'Asia/Shanghai', admin: { loginId: 'adm', displayName: 'x' } } });
    expect(good.status).toBe(201);
  });

  it('기업 생성 기록은 시스템 수준 감사 로그에 남고, 그 기업의 로그에는 운영자 정보가 없다', async () => {
    const id = uniq('audroot').toLowerCase();
    await makeUser(null, id, 'SYSTEM_ADMIN');
    const cookie = await sessionFor('OPERATOR', id);
    const created = await call(companiesCreate, { method: 'POST', cookie, body: { code: uniq('AUD'), name: 'x', admin: { loginId: 'adm', displayName: 'x' } } });
    const o = await owner();
    const sys = await o.query("SELECT company_id FROM app.audit_log WHERE action = 'COMPANY_CREATED' AND target_id = $1", [created.data.companyId]);
    expect(sys.rows).toEqual([{ company_id: null }]);
    expect((await o.query('SELECT 1 FROM app.audit_log WHERE company_id = $1', [created.data.companyId])).rowCount).toBe(0);
  });
});

describe('쿠키', () => {
  it('운영(HTTPS) 설정에서는 __Host- 접두사와 Secure 가 붙는다', async () => {
    const before = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = 'true';
    try {
      expect(sessionCookieName()).toBe('__Host-sm_session');
      expect(sessionCookie('abc')).toMatch(/^__Host-sm_session=abc; .*Path=\/; HttpOnly; SameSite=Lax; Secure$/);
      expect(sessionCookie('abc')).not.toMatch(/Domain=/i);
      expect(clearSessionCookie()).toMatch(/^__Host-sm_session=; Max-Age=0; /);
      // 접두사 없는 이름의 쿠키는 세션으로 인정되지 않는다.
      const s = await login({ companyCode: A.code, loginId: 'admin', password: GOOD_PASSWORD });
      if (!s.ok) throw new Error('login');
      expect((await call(meRoute, { cookie: `sm_session=${s.token}` })).status).toBe(401);
      expect((await call(meRoute, { cookie: `__Host-sm_session=${s.token}` })).status).toBe(200);
      expect(await resolveSession(s.token)).not.toBeNull();
    } finally {
      process.env.COOKIE_SECURE = before;
    }
  });
});
