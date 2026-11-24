import { z } from 'zod';
import { deleteModel, updateModel } from '@/lib/master/models';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Body = z.strictObject({
  categoryId: z.uuid().optional(),
  manufacturer: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(100).optional(),
});

export const PATCH = route(
  { access: 'permission', permission: { resource: 'master.model', operation: 'update' }, body: Body },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const modelId = id();
    await tenant((db) => updateModel(db, who, modelId, body));
    return json({ ok: true });
  },
);

export const DELETE = route(
  { access: 'permission', permission: { resource: 'master.model', operation: 'delete' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const modelId = id();
    await tenant((db) => deleteModel(db, who, modelId));
    return json({ ok: true });
  },
);
