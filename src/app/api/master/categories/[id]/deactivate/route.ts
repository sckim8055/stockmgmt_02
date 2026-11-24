import { setCategoryActive } from '@/lib/master/categories';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const POST = route(
  { access: 'permission', permission: { resource: 'master.category', operation: 'deactivate' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const categoryId = id();
    await tenant((db) => setCategoryActive(db, who, categoryId, false));
    return json({ ok: true });
  },
);
