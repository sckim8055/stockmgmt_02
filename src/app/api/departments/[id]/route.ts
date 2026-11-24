import { z } from 'zod';
import { deleteDepartment, updateDepartment } from '@/lib/master/departments';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 기본 부서 지정(is_default)과 활성 여부는 이 API로 바꾸지 않는다(활성 여부는 activate/deactivate).
const Body = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
});

export const PATCH = route(
  { access: 'permission', permission: { resource: 'master.department', operation: 'update' }, body: Body },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const departmentId = id();
    await tenant((db) => updateDepartment(db, who, departmentId, body));
    return json({ ok: true });
  },
);

export const DELETE = route(
  { access: 'permission', permission: { resource: 'master.department', operation: 'delete' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const departmentId = id();
    await tenant((db) => deleteDepartment(db, who, departmentId));
    return json({ ok: true });
  },
);
