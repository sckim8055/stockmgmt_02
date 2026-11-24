import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { createSchedule, listSchedules } from '@/lib/mail/schedules';
import { ScheduleCreateBody } from './schema';

export const GET = route(
  { access: 'permission', permission: { resource: 'mail.schedule', operation: 'read' } },
  async ({ actor, tenant }) => {
    const who = actor();
    return json({ schedules: await tenant(async (db) => listSchedules(db, who, await loadDataAccess(db, who))) });
  },
);

export const POST = route(
  { access: 'permission', permission: { resource: 'mail.schedule', operation: 'create' }, body: ScheduleCreateBody },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const scheduleId = await tenant(async (db) => createSchedule(db, who, await loadDataAccess(db, who), body));
    return json({ scheduleId }, { status: 201 });
  },
);
