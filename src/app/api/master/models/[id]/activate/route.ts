import { setModelActive } from '@/lib/master/models';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const POST = route(
  { access: 'permission', permission: { resource: 'master.model', operation: 'activate' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const modelId = id();
    await tenant((db) => setModelActive(db, who, modelId, true));
    return json({ ok: true });
  },
);
