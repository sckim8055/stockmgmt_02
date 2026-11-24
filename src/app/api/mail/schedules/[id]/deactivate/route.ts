import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { setScheduleActive } from '@/lib/mail/schedules';

export const POST = route(
  { access: 'permission', permission: { resource: 'mail.schedule', operation: 'deactivate' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const scheduleId = id();
    await tenant(async (db) => setScheduleActive(db, who, await loadDataAccess(db, who), scheduleId, false));
    return json({ ok: true });
  },
);
