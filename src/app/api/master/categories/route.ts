import { z } from 'zod';
import { str } from '@/lib/validation';
import { createCategory, listCategories } from '@/lib/master/categories';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Query = z.object({
  kind: z.enum(['ASSET', 'PERIPHERAL']).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

const Body = z.strictObject({
  kind: z.enum(['ASSET', 'PERIPHERAL']),
  name: str().trim().min(1).max(80),
  nameKo: str().trim().max(80).nullish(),
  nameZh: str().trim().max(80).nullish(),
  sortOrder: z.number().int().min(-100000).max(100000).optional(),
});

export const GET = route(
  { access: 'permission', permission: { resource: 'master.category', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    const query = { kind: parsed.data.kind, includeInactive: parsed.data.includeInactive === 'true' };
    return json({ categories: await tenant((db) => listCategories(db, who, query)) });
  },
);

export const POST = route(
  { access: 'permission', permission: { resource: 'master.category', operation: 'create' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const categoryId = await tenant((db) => createCategory(db, who, body));
    return json({ categoryId }, { status: 201 });
  },
);
