import { z } from 'zod';
import { isoDate, line, str } from '@/lib/validation';
import { ASSET_SORT_KEYS, createAsset, listAssets } from '@/lib/assets/assets';
import { isExactKey, parseExactParams } from '@/lib/assets/exact-params';
import { loadDataAccess } from '@/lib/authz/scope';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const date = isoDate();

const Query = z.object({
  state: z.enum(['ON_ORDER', 'IN_STOCK', 'IN_USE', 'MAINTENANCE', 'MISSING', 'RETIRED', 'VOID']).optional(),
  substate: z.enum(['AVAILABLE', 'RESERVED', 'DEFECTIVE', 'PENDING_DISPOSAL', 'DISPOSED', 'SOLD', 'DONATED']).optional(),
  modelId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  holderPersonId: z.uuid().optional(),
  q: str().max(100).optional(),
  // q 를 찾을 필드. 'all' 또는 열 필터와 같은 이름(asset_tag, serial, cf.<키> …). 이름의 최종 검사는 listAssets 가 한다.
  qField: line().max(64).optional(),
  includeVoid: z.enum(['true', 'false']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  // 퇴역 자산을 뺀다(운영 중인 자산만). 대시보드의 보증 만료 구간에서 들어올 때 쓴다.
  active: z.enum(['true', 'false']).optional(),
  sort: z.enum(ASSET_SORT_KEYS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  // 한 쪽에 보이는 행 수. 화면은 20·50·100·200 중에서 고르게 한다(200 이 상한, "전체"는 없다).
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * 열 필터: `f_<열>=<글자>` (열에 그 글자가 들어 있는 행만, 여러 개면 AND).
 *   <열> = asset_tag | category | manufacturer | model | serial | holder | employee_no | department | location
 *        | supplier | purchase_price | purchase_date | warranty_end | cf.<사용자 지정 필드 키>
 * 값은 앞뒤 공백을 자르고 100자까지, 제어 문자는 받지 않는다. 모르는 열은 400, 읽을 권한이 없는 열은 403(listAssets).
 *
 * 정확히 같은 값 조건(eq_manufacturer, eq_location, eq_cf.<키>, blank, hasHolder, purchaseFrom/To, noPurchaseDate,
 * warrantyFrom/To, noWarrantyEnd)은 parseExactParams 가 읽는다. 대시보드에서 "목록 보기"로 들어올 때 쓴다.
 */
const FILTER_PREFIX = 'f_';
const MAX_FILTERS = 40;
const FilterValue = line().max(100);
const FilterName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$|^cf\.[a-z][a-z0-9_]{0,39}$/);

function parseQuery(params: URLSearchParams): Parameters<typeof listAssets>[3] {
  const plain: Record<string, string> = {};
  const filters: Record<string, string> = {};
  let n = 0;
  for (const [key, value] of params) {
    if (isExactKey(key)) continue;
    if (!key.startsWith(FILTER_PREFIX)) {
      plain[key] = value;
      continue;
    }
    const name = key.slice(FILTER_PREFIX.length);
    const v = FilterValue.safeParse(value);
    if (!FilterName.safeParse(name).success || !v.success || Object.hasOwn(filters, name) || ++n > MAX_FILTERS) {
      throw badRequest('열 조건이 올바르지 않습니다.');
    }
    filters[name] = v.data;
  }
  const parsed = Query.safeParse(plain);
  if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
  const { includeVoid, overdue, active, ...rest } = parsed.data;
  return { ...rest, filters, exact: parseExactParams(params), includeVoid: includeVoid === 'true', overdue: overdue === 'true', active: active === 'true' };
}

const Body = z.object({
  modelId: z.uuid(),
  assetTag: line().trim().min(1).max(64),
  serialNumber: line().trim().max(100).nullish(),
  initialState: z.enum(['IN_STOCK', 'ON_ORDER']).optional(),
  departmentId: z.uuid().nullish(),
  location: str().trim().max(200).nullish(),
  purchaseDate: date.nullish(),
  purchasePrice: z.number().min(0).max(999999999999).nullish(),
  supplier: str().trim().max(200).nullish(),
  warrantyEnd: date.nullish(),
  custom: z.record(str(), z.unknown()).optional(),
});

export const GET = route(
  { access: 'permission', permission: { resource: 'asset.item', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const query = parseQuery(new URL(req.url).searchParams);
    const result = await tenant(async (db) => listAssets(db, who, await loadDataAccess(db, who), query));
    return json(result);
  },
);

export const POST = route(
  { access: 'permission', permission: { resource: 'asset.item', operation: 'create' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const assetId = await tenant(async (db) => createAsset(db, who, await loadDataAccess(db, who), body));
    return json({ assetId }, { status: 201 });
  },
);
