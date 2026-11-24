import { setCategoryActive } from '@/lib/master/categories';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const POST = route(
  { access: 'permission', permission: { resource: 'master.category', operation: 'activate' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const categoryId = id();
    await tenant((db) => setCategoryActive(db, who, categoryId, true));
    return json({ ok: true });
  },
);
