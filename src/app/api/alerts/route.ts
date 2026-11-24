import { z } from 'zod';
import { listAlerts } from '@/lib/alerts/inbox';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Query = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  // 메뉴의 읽지 않은 수 표시용 가벼운 요청
  light: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

// 자기 알림함.
export const GET = route(
  { access: 'permission', permission: { resource: 'alert.inbox', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    const { unreadOnly, light, ...rest } = parsed.data;
    return json(await tenant((db) => listAlerts(db, who, { ...rest, unreadOnly: unreadOnly === 'true', light: light === 'true' })));
  },
);
