import { z } from 'zod';
import { str } from '@/lib/validation';
import { createDepartment, listDepartments } from '@/lib/master/departments';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Body = z.strictObject({
  name: str().trim().min(1).max(80),
});

// 응답 형식 { departments: [{ id, name, is_default, is_active }] } 은 사용자 관리 화면도 쓴다. 바꾸지 않는다.
export const GET = route(
  { access: 'permission', permission: { resource: 'master.department', operation: 'read' } },
  async ({ actor, tenant }) => {
    const who = actor();
    return json({ departments: await tenant((db) => listDepartments(db, who)) });
  },
);

export const POST = route(
  { access: 'permission', permission: { resource: 'master.department', operation: 'create' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const departmentId = await tenant((db) => createDepartment(db, who, body));
    return json({ departmentId }, { status: 201 });
  },
);
