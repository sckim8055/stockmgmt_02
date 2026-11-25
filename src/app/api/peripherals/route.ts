import { z } from 'zod';
import { line, str } from '@/lib/validation';
import { loadDataAccess } from '@/lib/authz/scope';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { listStock, STOCK_SORT_KEYS, STOCK_TEXT_FIELDS, type StockTextField } from '@/lib/peripherals/peripherals';

const Query = z.object({
  modelId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  q: str().max(100).optional(),
  // q 를 찾을 열. 'all'(기본) 또는 열 필터와 같은 이름.
  qField: z.enum(['all', ...STOCK_TEXT_FIELDS] as [string, ...string[]]).optional(),
  sort: z.enum(STOCK_SORT_KEYS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * 열 필터: `f_<열>=<글자>` (열에 그 글자가 들어 있는 행만, 여러 개면 AND).
 *   <열> = category | manufacturer | model | department
 * 값은 앞뒤 공백을 자르고 100자까지, 제어 문자는 받지 않는다. 모르는 열은 400.
 */
const FILTER_PREFIX = 'f_';
const FilterValue = line().max(100);

function parseQuery(params: URLSearchParams): Parameters<typeof listStock>[3] {
  const plain: Record<string, string> = {};
  const filters: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!key.startsWith(FILTER_PREFIX)) {
      plain[key] = value;
      continue;
    }
    const name = key.slice(FILTER_PREFIX.length);
    const v = FilterValue.safeParse(value);
    if (!(STOCK_TEXT_FIELDS as string[]).includes(name) || !v.success || Object.hasOwn(filters, name)) {
      throw badRequest('열 조건이 올바르지 않습니다.');
    }
    filters[name as StockTextField] = v.data;
  }
  const parsed = Query.safeParse(plain);
  if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
  return { ...parsed.data, filters };
}

export const GET = route(
  { access: 'permission', permission: { resource: 'peripheral.stock', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const query = parseQuery(new URL(req.url).searchParams);
    return json(await tenant(async (db) => listStock(db, who, await loadDataAccess(db, who), query)));
  },
);
