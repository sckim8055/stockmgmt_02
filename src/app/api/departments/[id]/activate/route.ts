import { setDepartmentActive } from '@/lib/master/departments';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const POST = route(
  { access: 'permission', permission: { resource: 'master.department', operation: 'activate' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const departmentId = id();
    await tenant((db) => setDepartmentActive(db, who, departmentId, true));
    return json({ ok: true });
  },
);
