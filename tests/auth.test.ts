import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changePassword, login, LOCK_MINUTES, MAX_FAILED_LOGINS } from '@/lib/auth/login';
import { generateTempPassword, passwordPolicyError } from '@/lib/auth/password';
import { hashToken, resolveSession, revokeSession } from '@/lib/auth/session';
import { createCompany } from '@/lib/company/create';
import { closePool } from '@/lib/db/pool';
import { closeOwner, GOOD_PASSWORD, makeCompany, makeUser, owner, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;

beforeAll(async () => {
  A = await makeCompany('AUTA');
  B = await makeCompany('AUTB');
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

const ok = async (companyCode: string, loginId: string, password = GOOD_PASSWORD) => {
  const r = await login({ companyCode, loginId, password });
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe('로그인', () => {
  it('기업코드 + 로그인 ID + 비밀번호로 로그인한다(코드·ID는 대소문자 무시)', async () => {
    const r = await login({ companyCode: A.code.toLowerCase(), loginId: 'ADMIN', password: GOOD_PASSWORD });
    expect(r.ok).toBe(true);
  });

  it('같은 로그인 ID가 다른 기업에 있어도 서로 섞이지 않는다', async () => {
    const o = await owner();
    await o.query("UPDATE app.app_user SET display_name = 'B Admin' WHERE id = $1", [B.adminUserId]);
    const a = await ok(A.code, 'admin');
    const b = await ok(B.code, 'admin');
    expect(a.user.displayName).toBe('Admin');
    expect(b.user.displayName).toBe('B Admin');
    expect((await resolveSession(a.token))?.companyId).toBe(A.id);
    expect((await resolveSession(b.token))?.companyId).toBe(B.id);
  });

  it('틀린 비밀번호, 없는 ID, 없는 기업코드는 모두 같은 실패로 보인다', async () => {
    const r1 = await login({ companyCode: A.code, loginId: 'admin', password: 'wrong-password' });
    const r2 = await login({ companyCode: A.code, loginId: 'nobody', password: GOOD_PASSWORD });
    const r3 = await login({ companyCode: 'NOSUCHCO', loginId: 'admin', password: GOOD_PASSWORD });
    for (const r of [r1, r2, r3]) expect(r).toEqual({ ok: false, reason: 'INVALID' });
  });

  it('다른 기업의 비밀번호로는 로그인할 수 없다', async () => {
    const o = await owner();
    const other = await makeUser(B.id, 'onlyb', 'COMPANY_USER', { password: 'Only-B-Password-9' });
    expect(other).toBeTruthy();
    expect((await login({ companyCode: A.code, loginId: 'onlyb', password: 'Only-B-Password-9' })).ok).toBe(false);
    expect((await login({ companyCode: B.code, loginId: 'onlyb', password: 'Only-B-Password-9' })).ok).toBe(true);
    void o;
  });

  it(`${MAX_FAILED_LOGINS}회 연속 실패하면 잠기고, 잠긴 동안에는 맞는 비밀번호도 거부된다`, async () => {
    const id = uniq('lock').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) {
      expect((await login({ companyCode: A.code, loginId: id, password: 'bad' })).ok).toBe(false);
    }
    const o = await owner();
    const row = (await o.query('SELECT locked_until > now() AS locked, locked_until < now() + make_interval(mins => $2) AS bounded FROM app.app_user WHERE id = $1', [userId, LOCK_MINUTES + 1])).rows[0];
    expect(row).toEqual({ locked: true, bounded: true });
    expect(await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).toEqual({ ok: false, reason: 'LOCKED' });

    // 잠금 시간이 지나면 다시 로그인된다.
    await o.query("UPDATE app.app_user SET locked_until = now() - interval '1 second' WHERE id = $1", [userId]);
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(true);
  });

  it('로그인에 성공하면 실패 횟수가 초기화된다', async () => {
    const id = uniq('reset').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i += 1) await login({ companyCode: A.code, loginId: id, password: 'bad' });
    await ok(A.code, id);
    const o = await owner();
    expect((await o.query('SELECT failed_count FROM app.app_user WHERE id = $1', [userId])).rows[0].failed_count).toBe(0);
  });

  it('비활성 계정은 로그인할 수 없고, 이미 열린 세션도 즉시 무효가 된다', async () => {
    const id = uniq('off').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    const s = await ok(A.code, id);
    expect(await resolveSession(s.token)).not.toBeNull();
    const o = await owner();
    await o.query('UPDATE app.app_user SET is_active = false WHERE id = $1', [userId]);
    expect(await resolveSession(s.token)).toBeNull();
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(false);
  });

  it('기업을 비활성화하면 소속 전원의 로그인과 기존 세션이 차단된다', async () => {
    const C = await makeCompany('AUTC');
    const s = await ok(C.code, 'admin');
    const o = await owner();
    await o.query('UPDATE app.company SET is_active = false WHERE id = $1', [C.id]);
    expect(await resolveSession(s.token)).toBeNull();
    expect((await login({ companyCode: C.code, loginId: 'admin', password: GOOD_PASSWORD })).ok).toBe(false);
  });

  it('시스템 관리자는 운영사 코드로만 로그인한다', async () => {
    const id = uniq('root').toLowerCase();
    await makeUser(null, id, 'SYSTEM_ADMIN');
    expect((await login({ companyCode: 'OPERATOR', loginId: id, password: GOOD_PASSWORD })).ok).toBe(true);
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(false);
    // 기업 계정은 운영사 코드로 로그인할 수 없다.
    expect((await login({ companyCode: 'OPERATOR', loginId: 'admin', password: GOOD_PASSWORD })).ok).toBe(false);
  });

  it('운영사 코드와 같은 기업코드는 만들 수 없다', async () => {
    await expect(
      createCompany({ code: 'operator', name: 'x', admin: { loginId: 'admin', displayName: 'x' } }, { userId: null }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('같은 IP에서 실패가 누적되면 그 IP의 로그인 시도를 막는다', async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 30; i += 1) await login({ companyCode: 'NOSUCHCO', loginId: `x${i}`, password: 'bad', ip });
    expect(await login({ companyCode: A.code, loginId: 'admin', password: GOOD_PASSWORD, ip })).toEqual({ ok: false, reason: 'RATE_LIMITED' });
    // 다른 IP는 영향받지 않는다.
    expect((await login({ companyCode: A.code, loginId: 'admin', password: GOOD_PASSWORD, ip: '203.0.113.78' })).ok).toBe(true);
  });
});

describe('세션', () => {
  it('DB에는 세션 토큰의 해시만 저장된다', async () => {
    const s = await ok(A.code, 'admin');
    const o = await owner();
    const raw = await o.query('SELECT 1 FROM app.user_session WHERE token_hash = $1', [s.token]);
    const hashed = await o.query('SELECT 1 FROM app.user_session WHERE token_hash = $1', [hashToken(s.token)]);
    expect(raw.rowCount).toBe(0);
    expect(hashed.rowCount).toBe(1);
  });

  it('없는 토큰, 변조된 토큰은 거부된다', async () => {
    const s = await ok(A.code, 'admin');
    expect(await resolveSession(undefined)).toBeNull();
    expect(await resolveSession('')).toBeNull();
    expect(await resolveSession(`${s.token}x`)).toBeNull();
    expect(await resolveSession(hashToken(s.token))).toBeNull(); // DB의 해시값을 훔쳐도 토큰으로 쓸 수 없다
  });

  it('로그아웃(폐기)한 세션은 다시 쓸 수 없다', async () => {
    const s = await ok(A.code, 'admin');
    const u = await resolveSession(s.token);
    await revokeSession(u!.sessionId);
    expect(await resolveSession(s.token)).toBeNull();
  });

  it('만료 시각이 지났거나 오래 쓰지 않은 세션은 거부된다', async () => {
    const o = await owner();
    const s1 = await ok(A.code, 'admin');
    await o.query("UPDATE app.user_session SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(s1.token)]);
    expect(await resolveSession(s1.token)).toBeNull();
    const s2 = await ok(A.code, 'admin');
    await o.query("UPDATE app.user_session SET last_seen_at = now() - interval '121 minutes' WHERE token_hash = $1", [hashToken(s2.token)]);
    expect(await resolveSession(s2.token)).toBeNull();
  });
});

describe('비밀번호', () => {
  it('비밀번호는 argon2id 해시로만 저장된다', async () => {
    const o = await owner();
    const r = await o.query('SELECT password_hash FROM app.app_user WHERE id = $1', [A.adminUserId]);
    expect(r.rows[0].password_hash.startsWith('$argon2id$')).toBe(true);
    expect(r.rows[0].password_hash).not.toContain(GOOD_PASSWORD);
  });

  it('비밀번호 규칙', () => {
    expect(passwordPolicyError('Short-1a', 'kim')).not.toBeNull();
    expect(passwordPolicyError('alllowercaseletters', 'kim')).not.toBeNull();
    expect(passwordPolicyError('Has-Kim-Inside-99', 'kim')).not.toBeNull();
    expect(passwordPolicyError('Valid-Password-77', 'kim')).toBeNull();
    expect(passwordPolicyError(generateTempPassword(), 'kim')).toBeNull();
  });

  it('임시 비밀번호로 만든 계정은 비밀번호 변경이 강제된다', async () => {
    const code = uniq('TMP');
    const created = await createCompany({ code, name: 'Tmp', admin: { loginId: 'boss', displayName: 'Boss' } }, { userId: null });
    const s = await ok(code, 'boss', created.tempPassword);
    expect(s.user.mustChangePassword).toBe(true);
    expect((await resolveSession(s.token))?.mustChangePassword).toBe(true);
  });

  it('임시 비밀번호는 유효 기간이 지나면 쓸 수 없다', async () => {
    const code = uniq('EXP');
    const created = await createCompany({ code, name: 'Exp', admin: { loginId: 'boss', displayName: 'Boss' } }, { userId: null });
    const o = await owner();
    await o.query("UPDATE app.app_user SET temp_password_expires_at = now() - interval '1 minute' WHERE id = $1", [created.adminUserId]);
    expect(await login({ companyCode: code, loginId: 'boss', password: created.tempPassword })).toEqual({ ok: false, reason: 'TEMP_EXPIRED' });
  });

  it('비밀번호를 바꾸면 기존 세션이 모두 끊기고 새 세션만 유효하다', async () => {
    const id = uniq('chg').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER', { mustChange: true });
    const s1 = await ok(A.code, id);
    const s2 = await ok(A.code, id);
    const r = await changePassword({ userId, currentPassword: GOOD_PASSWORD, newPassword: 'Brand-New-Pass-88' });
    expect(r.ok).toBe(true);
    expect(await resolveSession(s1.token)).toBeNull();
    expect(await resolveSession(s2.token)).toBeNull();
    const fresh = await resolveSession(r.ok ? r.token : undefined);
    expect(fresh?.mustChangePassword).toBe(false);
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(false);
    expect((await login({ companyCode: A.code, loginId: id, password: 'Brand-New-Pass-88' })).ok).toBe(true);
  });

  it('현재 비밀번호가 틀리거나 규칙에 맞지 않으면 바뀌지 않는다', async () => {
    const id = uniq('nochg').toLowerCase();
    const userId = await makeUser(A.id, id, 'COMPANY_USER');
    expect(await changePassword({ userId, currentPassword: 'wrong', newPassword: 'Brand-New-Pass-88' })).toMatchObject({ ok: false, reason: 'WRONG_CURRENT' });
    expect(await changePassword({ userId, currentPassword: GOOD_PASSWORD, newPassword: 'weak' })).toMatchObject({ ok: false, reason: 'POLICY' });
    expect(await changePassword({ userId, currentPassword: GOOD_PASSWORD, newPassword: GOOD_PASSWORD })).toMatchObject({ ok: false, reason: 'SAME_AS_OLD' });
    expect((await login({ companyCode: A.code, loginId: id, password: GOOD_PASSWORD })).ok).toBe(true);
  });

  it('로그인 성공·실패와 비밀번호 변경이 감사 로그에 남고, 비밀값은 남지 않는다', async () => {
    const o = await owner();
    const r = await o.query("SELECT action, after::text AS after FROM app.audit_log WHERE company_id = $1 AND action IN ('LOGIN', 'LOGIN_FAILED', 'PASSWORD_CHANGED')", [A.id]);
    const actions = new Set(r.rows.map((x) => x.action));
    expect(actions.has('LOGIN') && actions.has('LOGIN_FAILED') && actions.has('PASSWORD_CHANGED')).toBe(true);
    const all = await o.query('SELECT coalesce(before::text, \'\') || coalesce(after::text, \'\') AS t FROM app.audit_log');
    for (const row of all.rows) {
      expect(row.t).not.toContain(GOOD_PASSWORD);
      expect(row.t).not.toContain('$argon2');
    }
  });
});
