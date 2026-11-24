// 기업 생성. 시스템 관리자 전용 기능이므로 withSystem 을 쓴다.
import { withSystem } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import { generateTempPassword, hashPassword, TEMP_PASSWORD_TTL_HOURS } from '@/lib/auth/password';
import { HttpError } from '@/lib/http/errors';
import { env } from '@/lib/env';

export interface CreateCompanyInput {
  code: string;
  name: string;
  timezone?: string;
  locale?: 'ko' | 'en' | 'zh';
  admin: { loginId: string; displayName: string; email?: string | null };
}

export interface CreateCompanyResult {
  companyId: string;
  adminUserId: string;
  /** 한 번만 보여준다. 어디에도 저장하지 않는다. */
  tempPassword: string;
}

/** 기업 + 기본 부서(IT) + 역할 템플릿 복사 + 첫 기업 관리자를 한 트랜잭션으로 만든다. */
export async function createCompany(
  input: CreateCompanyInput,
  actor: { userId: string | null; ip?: string | null },
): Promise<CreateCompanyResult> {
  const code = input.code.trim().toUpperCase();
  if (code === env.operatorCode) throw new HttpError(409, 'CODE_RESERVED', '사용할 수 없는 기업코드입니다.');
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  try {
    return await withSystem(async (db) => {
      const company = await db.query<{ id: string }>(
        `INSERT INTO app.company (code, name, timezone, locale) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, input.name.trim(), input.timezone ?? 'Asia/Seoul', input.locale ?? 'ko'],
      );
      const companyId = company.rows[0]!.id;

      await db.query(`INSERT INTO app.department (company_id, name, is_default) VALUES ($1, 'IT', true)`, [companyId]);

      // 역할 템플릿과 그 허용 목록을 이 기업의 역할로 복사한다.
      await db.query(
        `WITH copied AS (
           INSERT INTO app.role (company_id, name, description)
           SELECT $1, t.name, t.description FROM app.role t WHERE t.company_id IS NULL AND t.is_active
           RETURNING id, name
         )
         INSERT INTO app.role_acl (role_id, resource_code, operation)
         SELECT c.id, a.resource_code, a.operation
           FROM copied c
           JOIN app.role t ON t.company_id IS NULL AND t.name = c.name
           JOIN app.role_acl a ON a.role_id = t.id`,
        [companyId],
      );

      const admin = await db.query<{ id: string }>(
        `INSERT INTO app.app_user
           (company_id, login_id, password_hash, email, display_name, user_type, lang,
            must_change_password, temp_password_expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, 'COMPANY_ADMIN', $6, true, now() + make_interval(hours => $7), $8)
         RETURNING id`,
        [
          companyId,
          input.admin.loginId.trim(),
          passwordHash,
          input.admin.email?.trim() || null,
          input.admin.displayName.trim(),
          input.locale ?? 'ko',
          TEMP_PASSWORD_TTL_HOURS,
          actor.userId,
        ],
      );
      const adminUserId = admin.rows[0]!.id;

      // 시스템 수준 사건으로 남긴다(기업의 감사 로그에 운영자 계정·IP가 노출되지 않게).
      await writeAudit(db, {
        companyId: null,
        actorId: actor.userId,
        action: 'COMPANY_CREATED',
        resource: 'system.company',
        targetId: companyId,
        after: { code, name: input.name.trim(), adminLoginId: input.admin.loginId.trim() },
        ip: actor.ip,
      });
      return { companyId, adminUserId, tempPassword };
    });
  } catch (err) {
    if (typeof err === 'object' && err && (err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'DUPLICATE', '이미 사용 중인 기업코드입니다.');
    }
    if (typeof err === 'object' && err && (err as { code?: string }).code === '23514') {
      throw new HttpError(400, 'BAD_REQUEST', '입력값 형식이 올바르지 않습니다.');
    }
    throw err;
  }
}
