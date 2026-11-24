import { z } from 'zod';
import { line, str } from '@/lib/validation';
import { createModel, listModels } from '@/lib/master/models';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Query = z.object({
  kind: z.enum(['ASSET', 'PERIPHERAL']).optional(),
  categoryId: z.uuid().optional(),
  q: str().max(100).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

// 종류(kind)는 받지 않는다. 항상 카테고리에서 복사한다.
const Body = z.strictObject({
  categoryId: z.uuid(),
  manufacturer: line().trim().min(1).max(100),
  name: line().trim().min(1).max(100),
});

export const GET = route(
  { access: 'permission', permission: { resource: 'master.model', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    const { includeInactive, ...rest } = parsed.data;
    return json({ models: await tenant((db) => listModels(db, who, { ...rest, includeInactive: includeInactive === 'true' })) });
  },
);

export const POST = route(
  { access: 'permission', permission: { resource: 'master.model', operation: 'create' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const modelId = await tenant((db) => createModel(db, who, body));
    return json({ modelId }, { status: 201 });
  },
);
