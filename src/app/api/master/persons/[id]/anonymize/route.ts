import { anonymizePerson } from '@/lib/master/persons';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 비활성(퇴사) 직원의 이름·사번·이메일을 지운다. 되돌릴 수 없으므로 수정 권한이 아니라 퇴사 처리(deactivate) 권한을 요구한다.
export const POST = route(
  { access: 'permission', permission: { resource: 'master.person', operation: 'deactivate' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const personId = id();
    await tenant((db) => anonymizePerson(db, who, personId));
    return json({ ok: true });
  },
);
