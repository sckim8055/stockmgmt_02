import { z } from 'zod';
import { createPerson, listPersons } from '@/lib/master/persons';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Query = z.object({
  q: z.string().max(100).optional(),
  departmentId: z.uuid().optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

// 빈 문자열은 '없음'으로 저장한다.
const Email = z.string().trim().max(200).regex(/^$|^[^@\s]+@[^@\s]+\.[^@\s]+$/, '이메일 형식이 올바르지 않습니다.');

const Body = z.strictObject({
  employeeNo: z.string().trim().max(40).nullish(),
  name: z.string().trim().min(1).max(100),
  departmentId: z.uuid().nullish(),
  email: Email.nullish(),
});

// 직원 명부는 기업 전체의 것이라 부서 범위로 제한하지 않는다.
export const GET = route(
  { access: 'permission', permission: { resource: 'master.person', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    const { includeInactive, ...rest } = parsed.data;
    return json(await tenant((db) => listPersons(db, who, { ...rest, includeInactive: includeInactive === 'true' })));
  },
);

export const POST = route(
  { access: 'permission', permission: { resource: 'master.person', operation: 'create' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const personId = await tenant((db) => createPerson(db, who, body));
    return json({ personId }, { status: 201 });
  },
);
