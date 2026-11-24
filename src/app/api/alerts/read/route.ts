import { z } from 'zod';
import { markAlertsRead } from '@/lib/alerts/inbox';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// ids 를 주면 그 알림만, all 이면 전부 읽음 처리한다. 자기 알림만 바뀐다.
const Body = z.union([z.strictObject({ ids: z.array(z.uuid()).min(1).max(200) }), z.strictObject({ all: z.literal(true) })]);

export const POST = route(
  { access: 'permission', permission: { resource: 'alert.inbox', operation: 'read' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const updated = await tenant((db) => markAlertsRead(db, who, 'ids' in body ? body.ids : null));
    return json({ updated });
  },
);
