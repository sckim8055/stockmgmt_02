import { z } from 'zod';
import { isoDate, str } from '@/lib/validation';
import { loadDataAccess } from '@/lib/authz/scope';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { listAudit } from '@/lib/reports/history';

const Query = z.object({
  action: str().regex(/^[A-Z_]{1,60}$/).optional(),
  resource: str().regex(/^[a-z_.]{1,60}$/).optional(),
  actorId: z.uuid().optional(),
  targetId: str().max(64).optional(),
  from: isoDate().optional(),
  to: isoDate().optional(),
  page: z.coerce.number().int().min(1).max(500).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

// 기업의 감사 로그. 부서 범위 제한이 없는 사용자만 본다.
export const GET = route(
  { access: 'permission', permission: { resource: 'history.audit', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    return json(await tenant(async (db) => listAudit(db, who, await loadDataAccess(db, who), parsed.data)));
  },
);
