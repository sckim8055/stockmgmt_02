// 권한 판정. 기획서 3장의 판정 순서를 그대로 구현한다.
import { withTenant } from '@/lib/db/context';
import type { SessionUser } from './session';

export type Operation =
  | 'read' | 'create' | 'update' | 'delete' | 'activate' | 'deactivate' | 'import' | 'export' | 'execute';

export interface Permission {
  resource: string;
  operation: Operation;
}

/**
 * 사용자가 (리소스, 동작)을 할 수 있는가.
 * - 시스템 관리자: 항상 허용
 * - 기업 관리자: system.* 를 뺀 전부 허용
 * - 기업 사용자: 배정된 활성 역할의 허용 목록에 있을 때만 허용
 * 부서 범위와 제한 필드는 데이터 접근 단계에서 따로 적용한다.
 */
export async function hasPermission(user: SessionUser, p: Permission): Promise<boolean> {
  if (user.userType === 'SYSTEM_ADMIN') return true;
  if (p.resource.startsWith('system.')) return false;
  if (!user.companyId) return false;
  if (user.userType === 'COMPANY_ADMIN') return true;

  const companyId = user.companyId;
  return withTenant(companyId, async (db) => {
    const { rows } = await db.query(
      `SELECT 1
         FROM app.user_role ur
         JOIN app.role r ON r.id = ur.role_id AND r.is_active
         JOIN app.role_acl a ON a.role_id = r.id
        WHERE ur.user_id = $1 AND a.resource_code = $2 AND a.operation = $3
        LIMIT 1`,
      [user.userId, p.resource, p.operation],
    );
    return rows.length > 0;
  });
}
