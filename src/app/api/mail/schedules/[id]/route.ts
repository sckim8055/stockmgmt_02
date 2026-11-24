import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { deleteSchedule, updateSchedule } from '@/lib/mail/schedules';
import { ScheduleUpdateBody } from '../schema';

export const PATCH = route(
  { access: 'permission', permission: { resource: 'mail.schedule', operation: 'update' }, body: ScheduleUpdateBody },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const scheduleId = id();
    await tenant(async (db) => updateSchedule(db, who, await loadDataAccess(db, who), scheduleId, body));
    return json({ ok: true });
  },
);

export const DELETE = route(
  { access: 'permission', permission: { resource: 'mail.schedule', operation: 'delete' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const scheduleId = id();
    await tenant(async (db) => deleteSchedule(db, who, await loadDataAccess(db, who), scheduleId));
    return json({ ok: true });
  },
);
