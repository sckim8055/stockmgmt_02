import { z } from 'zod';
import { line, str } from '@/lib/validation';
import { deleteCustomField, updateCustomField } from '@/lib/master/custom-fields';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// key 와 dataType 은 바꿀 수 없다. 같은 값을 보내는 것만 허용하고, 다르면 400.
const Body = z.strictObject({
  key: str().max(40).optional(),
  dataType: z.enum(['text', 'number', 'date', 'boolean']).optional(),
  label: line().trim().min(1).max(80).optional(),
  isRestricted: z.boolean().optional(),
  sortOrder: z.number().int().min(-100000).max(100000).optional(),
  isActive: z.boolean().optional(),
});

export const PATCH = route(
  { access: 'permission', permission: { resource: 'master.custom_field', operation: 'update' }, body: Body },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const fieldId = id();
    await tenant((db) => updateCustomField(db, who, fieldId, body));
    return json({ ok: true });
  },
);

export const DELETE = route(
  { access: 'permission', permission: { resource: 'master.custom_field', operation: 'delete' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const fieldId = id();
    await tenant((db) => deleteCustomField(db, who, fieldId));
    return json({ ok: true });
  },
);
