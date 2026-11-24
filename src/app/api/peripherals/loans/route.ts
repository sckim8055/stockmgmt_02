import { z } from 'zod';
import { str } from '@/lib/validation';
import { loadDataAccess } from '@/lib/authz/scope';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { listLoans } from '@/lib/peripherals/peripherals';

const Query = z.object({
  status: z.enum(['OPEN', 'CLOSED', 'ALL']).optional(),
  personId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  overdue: z.enum(['true', 'false']).optional(),
  q: str().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

// 대여 현황. 기본은 미반납만 보여 준다.
export const GET = route(
  { access: 'permission', permission: { resource: 'peripheral.loan', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    const { status = 'OPEN', overdue, ...rest } = parsed.data;
    return json(
      await tenant(async (db) =>
        listLoans(db, who, await loadDataAccess(db, who), { ...rest, status: status === 'ALL' ? undefined : status, overdue: overdue === 'true' }),
      ),
    );
  },
);
