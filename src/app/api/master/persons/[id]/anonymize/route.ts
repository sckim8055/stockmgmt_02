import { anonymizePerson } from '@/lib/master/persons';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 비활성(퇴사) 직원의 이름·사번·이메일을 지운다. 되돌릴 수 없다.
export const POST = route(
  { access: 'permission', permission: { resource: 'master.person', operation: 'update' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const personId = id();
    await tenant((db) => anonymizePerson(db, who, personId));
    return json({ ok: true });
  },
);
