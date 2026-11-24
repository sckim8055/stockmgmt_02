import { z } from 'zod';
import { str } from '@/lib/validation';
import { deleteCategory, updateCategory } from '@/lib/master/categories';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 활성 여부는 activate/deactivate 로만 바꾼다.
const Body = z.strictObject({
  kind: z.enum(['ASSET', 'PERIPHERAL']).optional(),
  name: str().trim().min(1).max(80).optional(),
  nameKo: str().trim().max(80).nullable().optional(),
  nameZh: str().trim().max(80).nullable().optional(),
  sortOrder: z.number().int().min(-100000).max(100000).optional(),
});

export const PATCH = route(
  { access: 'permission', permission: { resource: 'master.category', operation: 'update' }, body: Body },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const categoryId = id();
    await tenant((db) => updateCategory(db, who, categoryId, body));
    return json({ ok: true });
  },
);

export const DELETE = route(
  { access: 'permission', permission: { resource: 'master.category', operation: 'delete' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const categoryId = id();
    await tenant((db) => deleteCategory(db, who, categoryId));
    return json({ ok: true });
  },
);
