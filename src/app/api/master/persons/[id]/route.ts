import { z } from 'zod';
import { updatePerson } from '@/lib/master/persons';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 직원은 삭제하지 않는다(DELETE 없음). 퇴사는 deactivate, 개인정보 삭제는 anonymize.
// 빈 문자열은 '없음'으로 저장한다.
const Email = z.string().trim().max(200).regex(/^$|^[^@\s]+@[^@\s]+\.[^@\s]+$/, '이메일 형식이 올바르지 않습니다.');

const Body = z.strictObject({
  employeeNo: z.string().trim().max(40).nullable().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  departmentId: z.uuid().nullable().optional(),
  email: Email.nullable().optional(),
});

export const PATCH = route(
  { access: 'permission', permission: { resource: 'master.person', operation: 'update' }, body: Body },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const personId = id();
    await tenant((db) => updatePerson(db, who, personId, body));
    return json({ ok: true });
  },
);
