import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { buildMailContent } from '@/lib/mail/content';
import { lockSchedule } from '@/lib/mail/schedules';

// 지금 발송된다면 어떤 내용이 나가는지 보여 준다. 아무것도 보내지 않는다.
export const GET = route(
  { access: 'permission', permission: { resource: 'mail.schedule', operation: 'read' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const scheduleId = id();
    const content = await tenant(async (db) => {
      const schedule = await lockSchedule(db, who, await loadDataAccess(db, who), scheduleId);
      return buildMailContent(db, who.companyId, schedule);
    });
    return json(content);
  },
);
