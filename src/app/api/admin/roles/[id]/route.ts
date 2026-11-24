import { z } from 'zod';
import { line, str } from '@/lib/validation';
import { deleteRole, updateRole } from '@/lib/admin/roles';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Body = z.object({
  name: line().trim().min(1).max(80).optional(),
  description: str().trim().max(300).nullable().optional(),
  isActive: z.boolean().optional(),
  acl: z
    .array(z.object({ resource: str().min(1).max(80), operation: str().min(1).max(20) }))
    .max(500)
    .optional(),
});

export const PATCH = route(
  { access: 'permission', permission: { resource: 'admin.role', operation: 'update' }, body: Body },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const roleId = id();
    await tenant((db) => updateRole(db, who, roleId, body, who.auditIp));
    return json({ ok: true });
  },
);

export const DELETE = route(
  { access: 'permission', permission: { resource: 'admin.role', operation: 'delete' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const roleId = id();
    await tenant((db) => deleteRole(db, who, roleId, who.auditIp));
    return json({ ok: true });
  },
);
