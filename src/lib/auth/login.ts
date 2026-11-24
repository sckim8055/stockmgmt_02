// 로그인과 비밀번호 변경. 인증 모듈이므로 withSystem 을 쓴다.
import { withSystem } from '@/lib/db/context';
import { env } from '@/lib/env';
import { writeAudit } from './audit';
import { burnVerify, hashPassword, passwordPolicyError, verifyPassword } from './password';
import { createSession, revokeAllSessions, type UserType } from './session';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
const IP_FAIL_LIMIT = 30; // 같은 IP에서 15분 동안 허용하는 실패 횟수

export interface LoginInput {
  companyCode: string;
  loginId: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

export type LoginResult =
  | { ok: true; token: string; user: { displayName: string; userType: UserType; lang: string; mustChangePassword: boolean } }
  // 실패 사유는 서버 로그·감사 로그에만 남기고, 응답에는 구분해서 내보내지 않는다.
  | { ok: false; reason: 'INVALID' | 'LOCKED' | 'RATE_LIMITED' | 'TEMP_EXPIRED' };

interface UserRow {
  id: string;
  company_id: string | null;
  password_hash: string;
  display_name: string;
  user_type: UserType;
  lang: string;
  is_active: boolean;
  must_change_password: boolean;
  temp_expired: boolean;
  locked: boolean;
  failed_count: number;
  company_active: boolean | null;
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const companyCode = input.companyCode.trim().toUpperCase();
  const loginId = input.loginId.trim();
  const ip = input.ip ?? null;

  // 실패해도 실패 횟수와 감사 로그를 남겨야 하므로, 예외를 던지지 않고 결과를 돌려준다(트랜잭션 커밋).
  return withSystem(async (db): Promise<LoginResult> => {
    if (ip) {
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.audit_log
          WHERE action = 'LOGIN_FAILED' AND ip = $1 AND created_at > now() - make_interval(mins => $2)`,
        [ip, LOCK_MINUTES],
      );
      if ((rows[0]?.n ?? 0) >= IP_FAIL_LIMIT) return { ok: false, reason: 'RATE_LIMITED' };
    }

    const isOperator = companyCode === env.operatorCode;
    const { rows } = await db.query<UserRow>(
      `SELECT u.id, u.company_id, u.password_hash, u.display_name, u.user_type, u.lang, u.is_active,
              u.must_change_password,
              (u.must_change_password AND u.temp_password_expires_at IS NOT NULL
                 AND u.temp_password_expires_at < now()) AS temp_expired,
              (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
              u.failed_count,
              c.is_active AS company_active
         FROM app.app_user u
         LEFT JOIN app.company c ON c.id = u.company_id
        WHERE lower(u.login_id) = lower($2)
          AND CASE WHEN $3::boolean THEN u.company_id IS NULL ELSE c.code = $1 END
        FOR UPDATE OF u`,
      [companyCode, loginId, isOperator],
    );
    const u = rows[0];

    const fail = async (reason: 'INVALID' | 'LOCKED' | 'TEMP_EXPIRED', detail: string): Promise<LoginResult> => {
      await writeAudit(db, {
        companyId: u?.company_id ?? null,
        actorId: u?.id ?? null,
        action: 'LOGIN_FAILED',
        resource: 'auth',
        // 입력값 원문(로그인 ID 칸에 비밀번호를 잘못 넣는 경우가 있다)은 남기지 않는다.
        after: { detail },
        ip,
      });
      return { ok: false, reason };
    };

    if (!u || !u.is_active || (u.company_id !== null && !u.company_active)) {
      await burnVerify(input.password);
      return fail('INVALID', !u ? 'unknown_account' : 'inactive');
    }
    if (u.locked) {
      await burnVerify(input.password);
      return fail('LOCKED', 'locked');
    }

    const passwordOk = await verifyPassword(u.password_hash, input.password);
    if (!passwordOk) {
      const reachedLimit = u.failed_count + 1 >= MAX_FAILED_LOGINS;
      await db.query(
        `UPDATE app.app_user
            SET failed_count = CASE WHEN $2 THEN 0 ELSE failed_count + 1 END,
                locked_until = CASE WHEN $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1`,
        [u.id, reachedLimit, LOCK_MINUTES],
      );
      return fail('INVALID', reachedLimit ? 'bad_password_locked' : 'bad_password');
    }
    if (u.temp_expired) return fail('TEMP_EXPIRED', 'temp_password_expired');

    await db.query('UPDATE app.app_user SET failed_count = 0, locked_until = NULL WHERE id = $1', [u.id]);
    const token = await createSession(db, u.id, { ip, userAgent: input.userAgent });
    await writeAudit(db, { companyId: u.company_id, actorId: u.id, action: 'LOGIN', resource: 'auth', ip });
    return {
      ok: true,
      token,
      user: {
        displayName: u.display_name,
        userType: u.user_type,
        lang: u.lang,
        mustChangePassword: u.must_change_password,
      },
    };
  });
}

export type ChangePasswordResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'WRONG_CURRENT' | 'POLICY' | 'SAME_AS_OLD'; message: string };

/** 본인 비밀번호 변경. 성공하면 기존 세션을 모두 끊고 새 세션 토큰을 돌려준다. */
export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ChangePasswordResult> {
  return withSystem(async (db): Promise<ChangePasswordResult> => {
    const { rows } = await db.query<{ company_id: string | null; login_id: string; password_hash: string }>(
      'SELECT company_id, login_id, password_hash FROM app.app_user WHERE id = $1 AND is_active FOR UPDATE',
      [input.userId],
    );
    const u = rows[0];
    if (!u || !(await verifyPassword(u.password_hash, input.currentPassword))) {
      return { ok: false, reason: 'WRONG_CURRENT', message: '현재 비밀번호가 올바르지 않습니다.' };
    }
    const policy = passwordPolicyError(input.newPassword, u.login_id);
    if (policy) return { ok: false, reason: 'POLICY', message: policy };
    if (input.newPassword === input.currentPassword) {
      return { ok: false, reason: 'SAME_AS_OLD', message: '현재 비밀번호와 다른 비밀번호를 써야 합니다.' };
    }

    await db.query(
      `UPDATE app.app_user
          SET password_hash = $2, must_change_password = false, temp_password_expires_at = NULL,
              password_changed_at = now(), failed_count = 0, locked_until = NULL
        WHERE id = $1`,
      [input.userId, await hashPassword(input.newPassword)],
    );
    await revokeAllSessions(db, input.userId);
    const token = await createSession(db, input.userId, { ip: input.ip, userAgent: input.userAgent });
    await writeAudit(db, {
      companyId: u.company_id,
      actorId: input.userId,
      action: 'PASSWORD_CHANGED',
      resource: 'auth',
      targetId: input.userId,
      ip: input.ip,
    });
    return { ok: true, token };
  });
}
