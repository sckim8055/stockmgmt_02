import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { loadDashboard } from '@/lib/reports/dashboard';

export const GET = route(
  { access: 'permission', permission: { resource: 'dashboard', operation: 'read' } },
  async ({ actor, tenant }) => {
    const who = actor();
    return json(await tenant(async (db) => loadDashboard(db, who, await loadDataAccess(db, who))));
  },
);
