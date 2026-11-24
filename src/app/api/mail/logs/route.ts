import { z } from 'zod';
import { loadDataAccess } from '@/lib/authz/scope';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { listMailLogs } from '@/lib/mail/schedules';

const Query = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = route(
  { access: 'permission', permission: { resource: 'mail.log', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    return json(await tenant(async (db) => listMailLogs(db, who, await loadDataAccess(db, who), parsed.data)));
  },
);
