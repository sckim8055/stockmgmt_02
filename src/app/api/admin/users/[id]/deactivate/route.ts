import { setUserActive } from '@/lib/admin/users';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const POST = route(
  { access: 'permission', permission: { resource: 'admin.user', operation: 'deactivate' } },
  async ({ id, actor, tenant, ip }) => {
    const who = actor();
    const targetId = id();
    await tenant((db) => setUserActive(db, who, targetId, false, ip));
    return json({ ok: true });
  },
);
