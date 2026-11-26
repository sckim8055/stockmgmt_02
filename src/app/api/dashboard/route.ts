import { z } from 'zod';
import { isExactKey, parseExactParams } from '@/lib/assets/exact-params';
import { loadDataAccess } from '@/lib/authz/scope';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { isDimensionName, loadDashboard } from '@/lib/reports/dashboard';

/**
 * 대시보드 조건(모두 선택). 자산 패널은 자산 목록과 같은 이름·같은 뜻의 조건을 받는다.
 *   state, substate, categoryId, modelId, departmentId
 *   active=true (퇴역 제외)
 *   eq_manufacturer, eq_location, eq_cf.<키>, blank, hasHolder, purchaseFrom/To, noPurchaseDate, warrantyFrom/To, noWarrantyEnd
 *   dimension   묶음 기준: category | manufacturer | model | department | location | holder | cf.<키>  (모르는 이름 400, 읽을 수 없는 제한 필드 403)
 *   trendMonths 이력 추이 기간: 3 | 6 | 12 (기본 12)
 *   excludeImports=true 이력 추이(와 이번 달 처리 수)에서 엑셀 업로드가 남긴 이력을 뺀다(기본: 넣는다)
 * 주변기기 패널에는 departmentId 만 적용된다(자산의 카테고리·상태 등은 주변기기에 없는 속성이다).
 * 모르는 매개변수는 400.
 */
const Query = z.strictObject({
  state: z.enum(['ON_ORDER', 'IN_STOCK', 'IN_USE', 'MAINTENANCE', 'MISSING', 'RETIRED']).optional(),
  substate: z.enum(['AVAILABLE', 'RESERVED', 'DEFECTIVE', 'PENDING_DISPOSAL', 'DISPOSED', 'SOLD', 'DONATED']).optional(),
  categoryId: z.uuid().optional(),
  modelId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  active: z.enum(['true']).optional(),
  dimension: z.string().max(43).refine(isDimensionName).optional(),
  trendMonths: z.enum(['3', '6', '12']).optional(),
  excludeImports: z.enum(['true']).optional(),
});

function parseQuery(params: URLSearchParams): Parameters<typeof loadDashboard>[3] {
  const plain: Record<string, string> = {};
  for (const [key, value] of params) {
    if (isExactKey(key)) continue;
    if (Object.hasOwn(plain, key)) throw badRequest('조회 조건이 올바르지 않습니다.');
    plain[key] = value;
  }
  const parsed = Query.safeParse(plain);
  if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
  const { trendMonths, active, excludeImports, ...rest } = parsed.data;
  return { ...rest, active: active === 'true', excludeImports: excludeImports === 'true', exact: parseExactParams(params), trendMonths: trendMonths ? (Number(trendMonths) as 3 | 6 | 12) : undefined };
}

export const GET = route(
  { access: 'permission', permission: { resource: 'dashboard', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const query = parseQuery(new URL(req.url).searchParams);
    return json(await tenant(async (db) => loadDashboard(db, who, await loadDataAccess(db, who), query)));
  },
);
