import { z } from 'zod';
import { str } from '@/lib/validation';
import { loadDataAccess } from '@/lib/authz/scope';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { listStock } from '@/lib/peripherals/peripherals';

const Query = z.object({
  modelId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  q: str().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = route(
  { access: 'permission', permission: { resource: 'peripheral.stock', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    return json(await tenant(async (db) => listStock(db, who, await loadDataAccess(db, who), parsed.data)));
  },
);
