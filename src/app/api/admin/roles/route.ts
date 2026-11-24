import { z } from 'zod';
import { line, str } from '@/lib/validation';
import { createRole, listRoles } from '@/lib/admin/roles';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Acl = z.array(z.object({ resource: str().min(1).max(80), operation: str().min(1).max(20) })).max(500);
const Body = z.object({
  name: line().trim().min(1).max(80),
  description: str().trim().max(300).nullish(),
  acl: Acl,
});

export const GET = route(
  { access: 'permission', permission: { resource: 'admin.role', operation: 'read' } },
  async ({ actor, tenant }) => {
    const who = actor();
    return json({ roles: await tenant((db) => listRoles(db, who)) });
  },
);

export const POST = route(
  { access: 'permission', permission: { resource: 'admin.role', operation: 'create' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const roleId = await tenant((db) => createRole(db, who, body, who.auditIp));
    return json({ roleId }, { status: 201 });
  },
);
