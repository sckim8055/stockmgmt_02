import { z } from 'zod';
import { updateUser } from '@/lib/admin/users';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Body = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  email: z.email().max(200).nullable().optional(),
  lang: z.enum(['ko', 'en', 'zh']).optional(),
  userType: z.enum(['COMPANY_ADMIN', 'COMPANY_USER']).optional(),
  roleIds: z.array(z.uuid()).max(50).optional(),
  departmentIds: z.array(z.uuid()).max(200).optional(),
});

export const PATCH = route(
  { access: 'permission', permission: { resource: 'admin.user', operation: 'update' }, body: Body },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const targetId = id();
    await tenant((db) => updateUser(db, who, targetId, body, who.auditIp));
    return json({ ok: true });
  },
);
