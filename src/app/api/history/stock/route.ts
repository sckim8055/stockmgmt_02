import { z } from 'zod';
import { isoDate, str } from '@/lib/validation';
import { loadDataAccess } from '@/lib/authz/scope';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { listStockHistory } from '@/lib/reports/history';

const Query = z.object({
  kind: z.enum(['ASSET', 'PERIPHERAL']).optional(),
  type: str().regex(/^[A-Z_]{1,30}$/).optional(),
  personId: z.uuid().optional(),
  q: str().max(100).optional(),
  from: isoDate().optional(),
  to: isoDate().optional(),
  page: z.coerce.number().int().min(1).max(500).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

// 기업 전체의 재고 이력(자산 + 주변기기). 부서 범위를 따른다.
export const GET = route(
  { access: 'permission', permission: { resource: 'history.stock', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    return json(await tenant(async (db) => listStockHistory(db, who, await loadDataAccess(db, who), parsed.data)));
  },
);
