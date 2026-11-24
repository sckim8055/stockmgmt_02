// 권한 상승 방지에 쓰는 계산.
//
// 원칙: 관리 권한(admin.user, admin.role)을 받은 기업 사용자는
//   - 자기가 가진 권한보다 큰 권한을 남에게 줄 수 없고
//   - 자기보다 권한이 큰 계정을 건드릴 수 없고
//   - 자기 부서 범위 밖으로 범위를 넓혀 줄 수 없다.
// 기업 관리자와 시스템 관리자(Actor.isAdmin)는 기업 안에서 제한이 없다.
import type { Db } from '@/lib/db/context';
import type { Actor } from '@/lib/http/route';

export const permKey = (resource: string, operation: string): string => `${resource}:${operation}`;

/** 계정이 활성 역할을 통해 가진 (리소스, 동작) 전체. */
export async function userPermissions(db: Db, userId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ resource_code: string; operation: string }>(
    `SELECT DISTINCT a.resource_code, a.operation
       FROM app.user_role ur
       JOIN app.role r ON r.id = ur.role_id AND r.is_active
       JOIN app.role_acl a ON a.role_id = r.id
      WHERE ur.user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => permKey(r.resource_code, r.operation)));
}

/** 계정의 부서 범위. null = 전체 부서. */
export async function userScope(db: Db, userId: string): Promise<string[] | null> {
  const { rows } = await db.query<{ department_id: string }>(
    'SELECT department_id FROM app.user_department_scope WHERE user_id = $1',
    [userId],
  );
  return rows.length === 0 ? null : rows.map((r) => r.department_id);
}

/** 요청자의 권한. null = 기업 안의 전부. */
export async function actorPermissions(db: Db, actor: Actor): Promise<Set<string> | null> {
  return actor.isAdmin ? null : userPermissions(db, actor.userId);
}

/** 요청자의 부서 범위. null = 전체 부서. */
export async function actorScope(db: Db, actor: Actor): Promise<string[] | null> {
  return actor.isAdmin ? null : userScope(db, actor.userId);
}

/** wanted 가 모두 allowed 안에 있는가. allowed 가 null 이면 제한 없음. */
export function withinPermissions(wanted: Iterable<string>, allowed: Set<string> | null): boolean {
  if (allowed === null) return true;
  for (const w of wanted) if (!allowed.has(w)) return false;
  return true;
}

/**
 * 부서 범위 wanted 가 allowed 안에 있는가.
 * allowed 가 null(전체)이면 무엇이든 가능. allowed 가 제한돼 있는데 wanted 가 null(전체)이면 불가.
 */
export function withinScope(wanted: string[] | null, allowed: string[] | null): boolean {
  if (allowed === null) return true;
  if (wanted === null) return false;
  const set = new Set(allowed);
  return wanted.every((d) => set.has(d));
}
