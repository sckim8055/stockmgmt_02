// 부서 범위와 제한 필드. 재고 데이터를 읽고 쓰는 모든 코드는 여기를 거친다.
//
// 부서 범위는 RLS로 강제되지 않는다(기업 격리와 달리 DB 안전망이 없다).
// 그래서 규칙을 한 곳에 모으고, 테스트(tests/assets.test.ts)로 모든 경로를 확인한다.
import type { Db } from '@/lib/db/context';
import type { Actor } from '@/lib/http/route';
import { actorPermissions, actorScope, permKey } from './grants';

export interface DataAccess {
  /** 접근할 수 있는 관리 부서. null = 전체. SQL 에는 `($n::uuid[] IS NULL OR department_id = ANY($n))` 로 넣는다. */
  scope: string[] | null;
  /** 범위 제한이 없는가. 관리 부서 변경처럼 범위를 넘나드는 작업은 이 값이 true 일 때만 허용한다. */
  unrestricted: boolean;
  canReadField(field: RestrictedField): boolean;
  canUpdateField(field: RestrictedField): boolean;
  inScope(departmentId: string): boolean;
}

/** 제한 필드. 리소스 코드는 0003_seed_permissions.sql 의 FIELD 리소스와 일치해야 한다. */
export const RESTRICTED_FIELDS = {
  purchase_price: 'asset.item.purchase_price',
  supplier: 'asset.item.supplier',
  custom_restricted: 'asset.item.custom_restricted',
} as const;
export type RestrictedField = keyof typeof RESTRICTED_FIELDS;

export async function loadDataAccess(db: Db, actor: Actor): Promise<DataAccess> {
  const [perms, scope] = [await actorPermissions(db, actor), await actorScope(db, actor)];
  const has = (field: RestrictedField, op: 'read' | 'update') =>
    perms === null || perms.has(permKey(RESTRICTED_FIELDS[field], op));
  const set = scope === null ? null : new Set(scope);
  return {
    scope,
    unrestricted: scope === null,
    canReadField: (f) => has(f, 'read'),
    canUpdateField: (f) => has(f, 'update'),
    inScope: (departmentId) => set === null || set.has(departmentId),
  };
}
