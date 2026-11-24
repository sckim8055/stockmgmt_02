import { setPersonActive } from '@/lib/master/persons';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const POST = route(
  { access: 'permission', permission: { resource: 'master.person', operation: 'activate' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const personId = id();
    await tenant((db) => setPersonActive(db, who, personId, true));
    return json({ ok: true });
  },
);
