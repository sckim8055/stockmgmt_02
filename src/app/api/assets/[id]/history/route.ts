import { listAssetHistory } from '@/lib/assets/assets';
import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const GET = route(
  { access: 'permission', permission: { resource: 'history.stock', operation: 'read' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const assetId = id();
    return json({ history: await tenant(async (db) => listAssetHistory(db, who, await loadDataAccess(db, who), assetId)) });
  },
);
