// 알림 만들기. 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 누가 받는가
//  - 그 기업의 활성 계정 중 기업 관리자, 그리고 켜져 있는 역할로 알림함 조회 권한(alert.inbox:read)을 가진 계정.
//  - 부서가 정해진 알림은 그 부서가 범위 안인 계정만, 기업 전체에 대한 알림은 범위 제한이 없는 계정만 받는다.
//    (범위가 제한된 계정에게 범위 밖 부서나 전사 수량이 알림으로 새지 않게)
import type { Db } from '@/lib/db/context';

export type AlertType = 'LOW_STOCK' | 'STOCK_RECOVERED' | 'WARRANTY_EXPIRING' | 'LOAN_OVERDUE';

// 계정 u 가 "기업 $1 의, 부서 i.department_id 에 대한 알림"을 받는가. i.department_id 가 NULL 이면 기업 전체에 대한 알림이다.
export const SQL_IS_RECIPIENT =
  ' u.company_id = $1 AND u.is_active' +
  " AND (u.user_type = 'COMPANY_ADMIN' OR (" +
  '       EXISTS (SELECT 1 FROM app.user_role ur JOIN app.role r ON r.id = ur.role_id AND r.is_active' +
  '                 JOIN app.role_acl acl ON acl.role_id = r.id' +
  "                WHERE ur.user_id = u.id AND ur.company_id = $1 AND acl.resource_code = 'alert.inbox' AND acl.operation = 'read')" +
  '       AND (NOT EXISTS (SELECT 1 FROM app.user_department_scope s WHERE s.user_id = u.id AND s.company_id = $1)' +
  '            OR EXISTS (SELECT 1 FROM app.user_department_scope s WHERE s.user_id = u.id AND s.company_id = $1 AND s.department_id = i.department_id))' +
  '     )) ';

// payload.key 가 있으면 같은 사람에게 같은 열쇠의 알림은 한 번만 만들어진다.
export const SQL_DEDUPE = " ON CONFLICT (user_id, (payload ->> 'key')) WHERE payload ? 'key' DO NOTHING";

const SQL_NOTIFY_ONE =
  'INSERT INTO app.notification (company_id, user_id, type, payload)' +
  ' SELECT $1, u.id, $3, $4::jsonb FROM app.app_user u CROSS JOIN (SELECT $2::uuid AS department_id) i WHERE' +
  SQL_IS_RECIPIENT +
  SQL_DEDUPE;

/** 받을 사람 모두에게 알림 하나를 만든다. 만든 알림 수를 돌려준다. */
export async function notify(db: Db, companyId: string, departmentId: string | null, type: AlertType, payload: Record<string, unknown>): Promise<number> {
  const result = await db.query(SQL_NOTIFY_ONE, [companyId, departmentId, type, JSON.stringify(payload)]);
  return result.rowCount ?? 0;
}
