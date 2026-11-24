import { unlockUser } from '@/lib/admin/users';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const POST = route(
  { access: 'permission', permission: { resource: 'admin.user', operation: 'update' } },
  async ({ id, actor, tenant, ip }) => {
    const who = actor();
    const targetId = id();
    await tenant((db) => unlockUser(db, who, targetId, ip));
    return json({ ok: true });
  },
);
