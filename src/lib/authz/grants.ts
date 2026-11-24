// 권한 상승 방지에 쓰는 계산.
//
// 원칙: 관리 권한(admin.user, admin.role)을 받은 기업 사용자는
//   - 자기가 가진 권한보다 큰 권한을 남에게 줄 수 없고
//   - 자기보다 권한이 큰 계정을 건드릴 수 없고
//   - 자기 부서 범위 밖으로 범위를 넓혀 줄 수 없다.
// 기업 관리자와 시스템 관리자(Actor.isAdmin)는 기업 안에서 제한이 없다.
import type { Db } from '@/lib/db/context';
import { HttpError } from '@/lib/http/errors';
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

/**
 * 계정에 "배정된" 모든 역할의 권한. 꺼져 있는(비활성) 역할도 포함한다.
 * 대상 계정이 요청자보다 큰지 판단할 때는 이 값을 쓴다. 비활성 역할을 빼고 판단하면,
 * 큰 역할이 잠시 꺼진 계정을 작은 권한의 담당자가 넘겨받은 뒤 역할이 다시 켜질 때 그 권한을 얻게 된다.
 */
export async function assignedPermissions(db: Db, userId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ resource_code: string; operation: string }>(
    `SELECT DISTINCT a.resource_code, a.operation
       FROM app.user_role ur
       JOIN app.role_acl a ON a.role_id = ur.role_id
      WHERE ur.user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => permKey(r.resource_code, r.operation)));
}

/**
 * 한 기업 안의 계정·역할 변경을 한 줄로 세운다(트랜잭션이 끝날 때까지 유지되는 잠금).
 * 권한 검사와 실제 변경 사이에 다른 요청이 역할이나 계정을 바꾸는 경쟁 상태,
 * 두 관리자가 서로를 동시에 바꿀 때의 교착, 같은 이름의 동시 생성을 한꺼번에 막는다.
 * 계정·역할 관리는 빈도가 낮아 직렬화해도 부담이 없다.
 */
export async function lockCompanyAdministration(db: Db, companyId: string): Promise<void> {
  await acquireCompanyLock(db, 727002, companyId);
}

/** 기업 단위 잠금을 기다리는 최대 시간. */
const COMPANY_LOCK_WAIT_MS = 2000;
const COMPANY_LOCK_RETRY_MS = 100;

/**
 * 기업 단위 잠금(트랜잭션이 끝날 때까지 유지)을 잡는다. 오래 기다리지 않는다:
 * 2초 안에 잡지 못하면 409(BUSY)로 끝낸다.
 *
 * 왜 기다리지 않는가: 기다리는 요청은 그동안 DB 연결을 하나씩 붙잡고 있다. 연결은 모든 기업이 함께 쓰므로,
 * 한 기업의 엑셀 업로드(이 잠금을 10초쯤 잡는다)가 끝나기를 그 기업의 요청 여러 건이 기다리면
 * 다른 기업의 요청까지 연결을 얻지 못해 실패한다.
 */
export async function acquireCompanyLock(db: Db, lockClass: number, companyId: string): Promise<void> {
  const deadline = Date.now() + COMPANY_LOCK_WAIT_MS;
  for (;;) {
    const { rows } = await db.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1::int, hashtext($2)) AS ok', [lockClass, companyId]);
    if (rows[0]?.ok) return;
    if (Date.now() >= deadline) throw new HttpError(409, 'BUSY', '이 기업의 다른 관리 작업(엑셀 업로드 등)이 처리 중입니다. 잠시 후 다시 시도하세요.');
    await new Promise((resolve) => setTimeout(resolve, COMPANY_LOCK_RETRY_MS));
  }
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
