// 로그인과 비밀번호 변경. 인증 모듈이므로 withSystem 을 쓴다.
//
// 흐름은 세 단계로 나눈다.
//   1) 계정 조회 (짧은 트랜잭션)
//   2) 비밀번호 검증 — DB 연결을 잡지 않은 채로 한다. argon2 가 무거워서, 연결을 잡고 있으면
//      로그인 시도가 몰릴 때 연결 풀이 바닥나 로그인한 사용자까지 멈춘다.
//   3) 결과 기록 (짧은 트랜잭션, 계정 행 잠금) — 잠금·실패 횟수는 여기서 다시 읽어 판정한다.
import { withSystem, type Db } from '@/lib/db/context';
import { env } from '@/lib/env';
import { writeAudit } from './audit';
import { BusyError, burnVerify, hashPassword, passwordPolicyError, verifyPassword } from './password';
import { createSession, revokeAllSessions, type UserType } from './session';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
export const IP_FAIL_LIMIT = 30; // 같은 IP에서 LOCK_MINUTES 동안 허용하는 실패 횟수

export interface LoginInput {
  companyCode: string;
  loginId: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

export type LoginResult =
  | { ok: true; token: string; user: { displayName: string; userType: UserType; lang: string; mustChangePassword: boolean } }
  // 실패 사유는 감사 로그에만 남기고, 응답에는 구분해서 내보내지 않는다.
  | { ok: false; reason: 'INVALID' | 'LOCKED' | 'RATE_LIMITED' | 'TEMP_EXPIRED' };

interface AccountState {
  id: string;
  company_id: string | null;
  password_hash: string | null;
  display_name: string;
  user_type: UserType;
  lang: string;
  usable: boolean; // 계정과 소속 기업이 모두 활성
  locked: boolean;
  failed_count: number;
  must_change_password: boolean;
  temp_expired: boolean;
}

const ACCOUNT_COLUMNS = `
  u.id, u.company_id, app.auth_password_hash(u.id) AS password_hash, u.display_name, u.user_type, u.lang,
  (u.is_active AND (u.company_id IS NULL OR c.is_active)) AS usable,
  (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
  u.failed_count, u.must_change_password,
  (u.must_change_password AND u.temp_password_expires_at IS NOT NULL AND u.temp_password_expires_at < now()) AS temp_expired`;

// SQL은 상수로만 조립한다(입력값은 항상 $1, $2 매개변수).
const SQL_ACCOUNT_FROM = ' FROM app.app_user u LEFT JOIN app.company c ON c.id = u.company_id ';
const SQL_ACCOUNT_BY_LOGIN =
  'SELECT' + ACCOUNT_COLUMNS + SQL_ACCOUNT_FROM +
  'WHERE lower(u.login_id) = lower($2) AND CASE WHEN $3::boolean THEN u.company_id IS NULL ELSE c.code = $1 END';
const SQL_ACCOUNT_BY_ID_LOCKED = 'SELECT' + ACCOUNT_COLUMNS + SQL_ACCOUNT_FROM + 'WHERE u.id = $1 FOR UPDATE OF u';

const SQL_PASSWORD_STATE =
  'SELECT u.company_id, u.login_id, app.auth_password_hash(u.id) AS password_hash, ' +
  '(u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked, u.failed_count ' +
  'FROM app.app_user u WHERE u.id = $1 AND u.is_active';
const SQL_PASSWORD_STATE_LOCKED = SQL_PASSWORD_STATE + ' FOR UPDATE';

/** 실패 횟수를 올리고, 한도에 닿으면 잠근다. 잠겼으면 true. 계정 행이 잠긴(FOR UPDATE) 상태에서 호출한다. */
async function recordFailure(db: Db, userId: string, failedCount: number): Promise<boolean> {
  const reachedLimit = failedCount + 1 >= MAX_FAILED_LOGINS;
  await db.query(
    `UPDATE app.app_user
        SET failed_count = CASE WHEN $2 THEN 0 ELSE failed_count + 1 END,
            locked_until = CASE WHEN $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
      WHERE id = $1`,
    [userId, reachedLimit, LOCK_MINUTES],
  );
  return reachedLimit;
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const companyCode = input.companyCode.trim().toUpperCase();
  const loginId = input.loginId.trim();
  const ip = input.ip ?? null;
  const isOperator = companyCode === env.operatorCode;

  // 1) 조회
  const pre = await withSystem(async (db) => {
    if (ip) {
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.audit_log
          WHERE action = 'LOGIN_FAILED' AND ip = $1 AND created_at > now() - make_interval(mins => $2)`,
        [ip, LOCK_MINUTES],
      );
      if ((rows[0]?.n ?? 0) >= IP_FAIL_LIMIT) return { rateLimited: true as const };
    }
    const { rows } = await db.query<AccountState>(SQL_ACCOUNT_BY_LOGIN, [companyCode, loginId, isOperator]);
    return { rateLimited: false as const, account: rows[0] };
  });
  if (pre.rateLimited) return { ok: false, reason: 'RATE_LIMITED' };
  const found = pre.account;

  // 2) 검증 (DB 연결 없이). 없는 계정·잠긴 계정도 같은 양의 계산을 해서 응답 시간으로 구분되지 않게 한다.
  let passwordOk = false;
  try {
    if (found?.usable && !found.locked && found.password_hash) {
      passwordOk = await verifyPassword(found.password_hash, input.password);
    } else {
      await burnVerify(input.password);
    }
  } catch (err) {
    if (err instanceof BusyError) return { ok: false, reason: 'RATE_LIMITED' };
    throw err;
  }

  // 3) 기록. 실패해도 실패 횟수와 감사 로그를 남겨야 하므로 예외를 던지지 않고 결과를 돌려준다.
  return withSystem(async (db): Promise<LoginResult> => {
    let now: AccountState | undefined;
    if (found) {
      const { rows } = await db.query<AccountState>(SQL_ACCOUNT_BY_ID_LOCKED, [found.id]);
      now = rows[0];
    }

    const fail = async (reason: 'INVALID' | 'LOCKED' | 'TEMP_EXPIRED', detail: string): Promise<LoginResult> => {
      await writeAudit(db, {
        companyId: now?.company_id ?? null,
        actorId: now?.id ?? null,
        action: 'LOGIN_FAILED',
        resource: 'auth',
        // 입력값 원문(로그인 ID 칸에 비밀번호를 잘못 넣는 경우가 있다)은 남기지 않는다.
        after: { detail },
        ip,
      });
      return { ok: false, reason };
    };

    if (!found || !now) return fail('INVALID', 'unknown_account');
    if (!now.usable) return fail('INVALID', 'inactive');
    // 조회 시점에 잠겨 있었다면 비밀번호를 검증하지 않았으므로 성공시킬 수 없다.
    // 그 사이 다른 시도가 잠갔다면(now.locked) 맞는 비밀번호여도 거부한다.
    if (found.locked || now.locked) return fail('LOCKED', 'locked');
    // 검증하는 사이에 비밀번호가 바뀌었다면 옛 해시로 한 검증은 무효다.
    if (now.password_hash !== found.password_hash) return fail('INVALID', 'password_changed_meanwhile');

    if (!passwordOk) {
      const lockedNow = await recordFailure(db, now.id, now.failed_count);
      return fail('INVALID', lockedNow ? 'bad_password_locked' : 'bad_password');
    }
    if (now.temp_expired) return fail('TEMP_EXPIRED', 'temp_password_expired');

    await db.query('UPDATE app.app_user SET failed_count = 0, locked_until = NULL WHERE id = $1', [now.id]);
    const token = await createSession(db, now.id, { ip, userAgent: input.userAgent });
    await writeAudit(db, { companyId: now.company_id, actorId: now.id, action: 'LOGIN', resource: 'auth', ip });
    return {
      ok: true,
      token,
      user: {
        displayName: now.display_name,
        userType: now.user_type,
        lang: now.lang,
        mustChangePassword: now.must_change_password,
      },
    };
  });
}

export type ChangePasswordResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'WRONG_CURRENT' | 'POLICY' | 'SAME_AS_OLD' | 'LOCKED' | 'BUSY'; message: string };

const WRONG_CURRENT: ChangePasswordResult = { ok: false, reason: 'WRONG_CURRENT', message: '현재 비밀번호가 올바르지 않습니다.' };

/**
 * 본인 비밀번호 변경. 성공하면 기존 세션을 모두 끊고 새 세션 토큰을 돌려준다.
 * 현재 비밀번호를 틀리면 로그인 실패와 똑같이 센다(세션을 훔친 사람이 비밀번호를 무제한으로 추측하지 못하게).
 */
export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ChangePasswordResult> {
  const ip = input.ip ?? null;
  type State = { company_id: string | null; login_id: string; password_hash: string | null; locked: boolean; failed_count: number };
  const read = (db: Db, lock: boolean) =>
    db.query<State>(lock ? SQL_PASSWORD_STATE_LOCKED : SQL_PASSWORD_STATE, [input.userId]);

  const found = (await withSystem((db) => read(db, false))).rows[0];
  if (!found?.password_hash) return WRONG_CURRENT;
  if (found.locked) return { ok: false, reason: 'LOCKED', message: '잠시 후 다시 시도하세요.' };

  let currentOk: boolean;
  let newHash: string | null = null;
  const policy = passwordPolicyError(input.newPassword, found.login_id);
  try {
    currentOk = await verifyPassword(found.password_hash, input.currentPassword);
    if (currentOk && !policy && input.newPassword !== input.currentPassword) newHash = await hashPassword(input.newPassword);
  } catch (err) {
    if (err instanceof BusyError) return { ok: false, reason: 'BUSY', message: '잠시 후 다시 시도하세요.' };
    throw err;
  }

  return withSystem(async (db): Promise<ChangePasswordResult> => {
    const now = (await read(db, true)).rows[0];
    if (!now || now.password_hash !== found.password_hash) return WRONG_CURRENT;
    if (now.locked) return { ok: false, reason: 'LOCKED', message: '잠시 후 다시 시도하세요.' };

    if (!currentOk) {
      const lockedNow = await recordFailure(db, input.userId, now.failed_count);
      // 한도에 닿으면 이 세션을 포함해 모두 끊는다.
      if (lockedNow) await revokeAllSessions(db, input.userId);
      await writeAudit(db, {
        companyId: now.company_id,
        actorId: input.userId,
        action: 'PASSWORD_CHANGE_FAILED',
        resource: 'auth',
        targetId: input.userId,
        after: { detail: lockedNow ? 'wrong_current_locked' : 'wrong_current' },
        ip,
      });
      return WRONG_CURRENT;
    }
    if (policy) return { ok: false, reason: 'POLICY', message: policy };
    if (!newHash) return { ok: false, reason: 'SAME_AS_OLD', message: '현재 비밀번호와 다른 비밀번호를 써야 합니다.' };

    await db.query(
      `UPDATE app.app_user
          SET password_hash = $2, must_change_password = false, temp_password_expires_at = NULL,
              password_changed_at = now(), failed_count = 0, locked_until = NULL
        WHERE id = $1`,
      [input.userId, newHash],
    );
    await revokeAllSessions(db, input.userId);
    const token = await createSession(db, input.userId, { ip, userAgent: input.userAgent });
    await writeAudit(db, {
      companyId: now.company_id,
      actorId: input.userId,
      action: 'PASSWORD_CHANGED',
      resource: 'auth',
      targetId: input.userId,
      ip,
    });
    return { ok: true, token };
  });
}
