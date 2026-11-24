// 세션. 이 파일은 인증 모듈이므로 withSystem 을 쓴다(로그인 전에는 기업을 알 수 없다).
import { createHash, randomBytes } from 'node:crypto';
import { withSystem, type Db } from '@/lib/db/context';
import { writeAudit } from './audit';

export const SESSION_COOKIE = 'sm_session';
export const SESSION_ABSOLUTE_HOURS = 12; // 로그인 후 최대 유지 시간
export const SESSION_IDLE_MINUTES = 120; // 마지막 요청 이후 유지 시간

export type UserType = 'SYSTEM_ADMIN' | 'COMPANY_ADMIN' | 'COMPANY_USER';

export interface SessionUser {
  sessionId: string;
  userId: string;
  /** 계정의 소속 기업. 시스템 관리자는 null. */
  companyId: string | null;
  /** 시스템 관리자가 이 세션에서 고른 기업. 그 외에는 null. */
  actingCompanyId: string | null;
  loginId: string;
  displayName: string;
  userType: UserType;
  lang: string;
  mustChangePassword: boolean;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 세션을 만들고 토큰 원문을 돌려준다. DB에는 해시만 저장된다. */
export async function createSession(
  db: Db,
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO app.user_session (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [userId, hashToken(token), SESSION_ABSOLUTE_HOURS, meta.ip ?? null, (meta.userAgent ?? '').slice(0, 300) || null],
  );
  return token;
}

interface SessionRow {
  session_id: string;
  stale: boolean;
  id: string;
  company_id: string | null;
  acting_company_id: string | null;
  login_id: string;
  display_name: string;
  user_type: UserType;
  lang: string;
  must_change_password: boolean;
}

/**
 * 토큰으로 사용자를 찾는다. 다음 중 하나라도 해당하면 null:
 * 폐기됨, 만료됨, 오래 미사용, 계정 비활성, 소속 기업 비활성.
 */
export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  return withSystem(async (db) => {
    const { rows } = await db.query<SessionRow>(
      `SELECT s.id AS session_id,
              s.last_seen_at < now() - interval '60 seconds' AS stale,
              u.id, u.company_id, u.login_id, u.display_name, u.user_type, u.lang, u.must_change_password,
              -- 고른 기업은 시스템 관리자일 때만, 그리고 그 기업이 활성일 때만 인정한다.
              CASE WHEN u.user_type = 'SYSTEM_ADMIN' THEN ac.id END AS acting_company_id
         FROM app.user_session s
         JOIN app.app_user u ON u.id = s.user_id
         LEFT JOIN app.company c ON c.id = u.company_id
         LEFT JOIN app.company ac ON ac.id = s.acting_company_id AND ac.is_active
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(mins => $2)
          AND u.is_active
          AND (u.company_id IS NULL OR c.is_active)`,
      [hashToken(token), SESSION_IDLE_MINUTES],
    );
    const r = rows[0];
    if (!r) return null;
    if (r.stale) await db.query('UPDATE app.user_session SET last_seen_at = now() WHERE id = $1', [r.session_id]);
    return {
      sessionId: r.session_id,
      userId: r.id,
      companyId: r.company_id,
      actingCompanyId: r.acting_company_id,
      loginId: r.login_id,
      displayName: r.display_name,
      userType: r.user_type,
      lang: r.lang,
      mustChangePassword: r.must_change_password,
    };
  });
}

export async function revokeSession(sessionId: string): Promise<void> {
  await withSystem((db) =>
    db.query('UPDATE app.user_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]),
  );
}

/**
 * 한 계정의 모든 세션을 끊는다. 비밀번호 변경, 임시 비밀번호 발급, 비활성화 때 호출한다.
 * 기업 문맥에서도 동작해야 하므로(관리자가 직원 계정을 비활성화) DB 함수를 거친다.
 * 그 함수는 기업 문맥에서는 자기 기업 계정의 세션만 끊는다.
 */
export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db.query('SELECT app.revoke_user_sessions($1)', [userId]);
}

/**
 * 시스템 관리자가 작업할 기업을 고른다(null 이면 해제).
 * 접근 사실을 그 기업의 감사 로그에 남겨, 기업 관리자가 운영자의 접근을 확인할 수 있게 한다.
 * 고를 수 없는 기업(없음·비활성)이면 false.
 */
export async function setActingCompany(
  user: SessionUser,
  companyId: string | null,
  ip: string | null,
): Promise<boolean> {
  if (user.userType !== 'SYSTEM_ADMIN') return false;
  return withSystem(async (db) => {
    if (companyId) {
      const { rowCount } = await db.query('SELECT 1 FROM app.company WHERE id = $1 AND is_active', [companyId]);
      if (!rowCount) return false;
    }
    await db.query('UPDATE app.user_session SET acting_company_id = $2 WHERE id = $1', [user.sessionId, companyId]);
    if (companyId) {
      await writeAudit(db, {
        companyId,
        actorId: user.userId,
        action: 'SYSTEM_ADMIN_ENTERED',
        resource: 'system',
        after: { operator: user.loginId },
        ip,
      });
    }
    return true;
  });
}
