// 정기 메일 일정과 받는 사람. 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 규칙
//  - 일정은 만들 때 꺼져 있다. 받는 사람이 한 명 이상 있어야 켤 수 있고, 켤 때 다음 발송 시각을 계산한다.
//  - 부서가 정해진 일정은 그 부서의 자료만 보낸다. 부서 범위가 제한된 사용자는 자기 범위의 부서에 대한 일정만 보고 관리한다.
//    기업 전체 일정은 범위 제한이 없는 사용자만.
//  - 받는 사람은 그 기업의 활성 계정(이메일이 있어야 한다) 또는 직접 적은 이메일 주소.
//  - 발송 기록이 있는 일정은 지우지 않는다(끄기만 한다).
//  - 실제 발송은 정기 실행기가 한다(아직 없다). 여기서는 일정 관리와 미리보기까지만 한다.
import type { Db } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import type { DataAccess } from '@/lib/authz/scope';
import { badRequest, forbidden, HttpError, notFound } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';

const RESOURCE = 'mail.schedule';
const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const MAX_RECIPIENTS = 50;

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type ContentType = 'LOW_STOCK' | 'STOCK_SUMMARY' | 'OPEN_LOANS';

export interface ScheduleInput {
  name: string;
  frequency: Frequency;
  /** WEEKLY: 요일(1=월 … 7=일), MONTHLY: 날짜(1~31). DAILY 는 쓰지 않는다. */
  days?: number[];
  /** HH:MM */
  sendTime: string;
  timezone: string;
  contentType: ContentType;
  departmentId?: string | null;
  skipIfEmpty?: boolean;
  lang?: 'ko' | 'en' | 'zh';
  recipients: { userIds: string[]; emails: string[] };
}

// $1 기업, $2 부서 범위
const SQL_SCHEDULE_VISIBLE = ' s.company_id = $1 AND ($2::uuid[] IS NULL OR s.department_id = ANY($2)) ';
const SQL_SCHEDULE_LIST =
  'SELECT s.id, s.name, s.frequency, s.days, to_char(s.send_time, $3) AS send_time, s.timezone, s.content_type, s.department_id, d.name AS department_name,' +
  ' s.skip_if_empty, s.lang, s.is_active, s.next_run_at, s.last_run_at,' +
  ' coalesce((SELECT jsonb_agg(jsonb_build_object($4::text, r.user_id, $5::text, u.display_name, $6::text, coalesce(r.email, u.email)) ORDER BY r.id)' +
  '             FROM app.mail_recipient r LEFT JOIN app.app_user u ON u.id = r.user_id AND u.company_id = r.company_id' +
  '            WHERE r.schedule_id = s.id AND r.company_id = s.company_id), $7::jsonb) AS recipients' +
  ' FROM app.mail_schedule s LEFT JOIN app.department d ON d.id = s.department_id AND d.company_id = s.company_id' +
  ' WHERE' + SQL_SCHEDULE_VISIBLE + 'ORDER BY lower(s.name), s.id';
const SQL_SCHEDULE_LOCK =
  'SELECT s.id, s.name, s.frequency, s.days, to_char(s.send_time, $4) AS send_time, s.timezone, s.content_type, s.department_id, s.skip_if_empty, s.lang, s.is_active' +
  ' FROM app.mail_schedule s WHERE s.id = $3 AND' + SQL_SCHEDULE_VISIBLE + 'FOR UPDATE';

// 다음 발송 시각: 일정의 시간대에서 오늘부터 62일 안의 날짜 중 조건에 맞고 지금보다 뒤인 첫 시각.
// $1 시간대, $2 시각, $3 매일 여부, $4 요일들(주간) 또는 NULL, $5 날짜들(월간) 또는 NULL, $6 = '1 day'
const SQL_NEXT_RUN =
  'SELECT min(x.ts) AS next FROM (' +
  '  SELECT ((g.d::date + $2::time) AT TIME ZONE $1) AS ts, g.d FROM generate_series((now() AT TIME ZONE $1)::date::timestamp, (now() AT TIME ZONE $1)::date + 62, $6::interval) AS g(d)' +
  ') x WHERE x.ts > now() AND ($3::boolean OR extract(isodow FROM x.d)::int = ANY($4::int[]) OR extract(day FROM x.d)::int = ANY($5::int[]))';

export interface ScheduleRow {
  id: string;
  name: string;
  frequency: Frequency;
  days: number[];
  send_time: string;
  timezone: string;
  content_type: ContentType;
  department_id: string | null;
  skip_if_empty: boolean;
  lang: 'ko' | 'en' | 'zh';
  is_active: boolean;
}

export async function listSchedules(db: Db, actor: Actor, access: DataAccess): Promise<unknown[]> {
  return (await db.query(SQL_SCHEDULE_LIST, [actor.companyId, access.scope, 'HH24:MI', 'userId', 'name', 'email', '[]'])).rows;
}

export async function lockSchedule(db: Db, actor: Actor, access: DataAccess, id: string): Promise<ScheduleRow> {
  const { rows } = await db.query<ScheduleRow>(SQL_SCHEDULE_LOCK, [actor.companyId, access.scope, id, 'HH24:MI']);
  if (!rows[0]) throw notFound();
  return rows[0];
}

function normalizeDays(frequency: Frequency, days: number[] | undefined): number[] {
  if (frequency === 'DAILY') return [];
  const max = frequency === 'WEEKLY' ? 7 : 31;
  const unique = [...new Set(days ?? [])].sort((a, b) => a - b);
  if (unique.length === 0) throw badRequest(frequency === 'WEEKLY' ? '요일을 하나 이상 골라야 합니다.' : '날짜를 하나 이상 골라야 합니다.');
  if (unique.some((d) => !Number.isInteger(d) || d < 1 || d > max)) throw badRequest('요일 또는 날짜 값이 올바르지 않습니다.');
  return unique;
}

async function assertTimezone(db: Db, timezone: string): Promise<void> {
  const { rowCount } = await db.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [timezone]);
  if (!rowCount) throw badRequest('알 수 없는 시간대입니다.');
}

async function assertDepartment(db: Db, actor: Actor, access: DataAccess, departmentId: string | null): Promise<void> {
  if (departmentId === null) {
    if (!access.unrestricted) throw forbidden('기업 전체에 대한 메일 일정은 부서 범위 제한이 없는 사용자만 만들 수 있습니다.');
    return;
  }
  if (!access.inScope(departmentId)) throw forbidden('자신의 부서 범위 밖입니다.');
  const { rowCount } = await db.query('SELECT 1 FROM app.department WHERE id = $1 AND company_id = $2 AND is_active FOR SHARE', [departmentId, actor.companyId]);
  if (!rowCount) throw badRequest('선택할 수 없는 부서입니다.');
}

async function replaceRecipients(db: Db, actor: Actor, scheduleId: string, recipients: { userIds: string[]; emails: string[] }): Promise<void> {
  const userIds = [...new Set(recipients.userIds)];
  const emails = [...new Set(recipients.emails.map((e) => e.toLowerCase()))];
  if (userIds.length + emails.length > MAX_RECIPIENTS) throw badRequest(`받는 사람은 최대 ${MAX_RECIPIENTS}명입니다.`);
  if (userIds.length) {
    // 그 기업의 활성 계정이고 이메일이 있어야 한다.
    const ok = await db.query<{ id: string }>(
      'SELECT id FROM app.app_user WHERE company_id = $1 AND id = ANY($2::uuid[]) AND is_active AND email IS NOT NULL',
      [actor.companyId, userIds],
    );
    if (ok.rows.length !== userIds.length) throw badRequest('받는 사람으로 고를 수 없는 계정이 있습니다. (비활성이거나 이메일이 없는 계정)');
  }
  await db.query('DELETE FROM app.mail_recipient WHERE schedule_id = $1 AND company_id = $2', [scheduleId, actor.companyId]);
  if (userIds.length) {
    await db.query('INSERT INTO app.mail_recipient (company_id, schedule_id, user_id) SELECT $1, $2, unnest($3::uuid[])', [actor.companyId, scheduleId, userIds]);
  }
  if (emails.length) {
    await db.query('INSERT INTO app.mail_recipient (company_id, schedule_id, email) SELECT $1, $2, unnest($3::text[])', [actor.companyId, scheduleId, emails]);
  }
}

async function nextRun(db: Db, s: { frequency: Frequency; days: number[]; send_time: string; timezone: string }): Promise<Date | null> {
  const { rows } = await db.query<{ next: Date | null }>(SQL_NEXT_RUN, [
    s.timezone, s.send_time, s.frequency === 'DAILY', s.frequency === 'WEEKLY' ? s.days : null, s.frequency === 'MONTHLY' ? s.days : null, '1 day',
  ]);
  return rows[0]?.next ?? null;
}

export async function createSchedule(db: Db, actor: Actor, access: DataAccess, input: ScheduleInput): Promise<string> {
  const days = normalizeDays(input.frequency, input.days);
  await assertTimezone(db, input.timezone);
  await assertDepartment(db, actor, access, input.departmentId ?? null);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO app.mail_schedule (company_id, name, frequency, days, send_time, timezone, content_type, department_id, skip_if_empty, lang)
     VALUES ($1, $2, $3, $4, $5::time, $6, $7, $8, $9, $10) RETURNING id`,
    [actor.companyId, input.name, input.frequency, days, input.sendTime, input.timezone, input.contentType, input.departmentId ?? null, input.skipIfEmpty ?? true, input.lang ?? 'ko'],
  );
  const id = rows[0]!.id;
  await replaceRecipients(db, actor, id, input.recipients);
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'MAIL_SCHEDULE_CREATED', resource: RESOURCE, targetId: id,
    after: { name: input.name, frequency: input.frequency, days, sendTime: input.sendTime, timezone: input.timezone, contentType: input.contentType, departmentId: input.departmentId ?? null, recipients: input.recipients.userIds.length + input.recipients.emails.length },
    ip: actor.auditIp,
  });
  return id;
}

/** 부서는 바꿀 수 없다(무엇을 누구에게 보내는지가 달라지므로, 새 일정을 만든다). */
export async function updateSchedule(db: Db, actor: Actor, access: DataAccess, id: string, input: Partial<Omit<ScheduleInput, 'departmentId'>>): Promise<void> {
  const s = await lockSchedule(db, actor, access, id);
  if (Object.values(input).every((v) => v === undefined)) return;
  const frequency = input.frequency ?? s.frequency;
  const days = input.frequency !== undefined || input.days !== undefined ? normalizeDays(frequency, input.days ?? s.days) : s.days;
  if (input.timezone !== undefined) await assertTimezone(db, input.timezone);
  const sendTime = input.sendTime ?? s.send_time;
  const timezone = input.timezone ?? s.timezone;
  if (input.recipients) {
    if (s.is_active && input.recipients.userIds.length + input.recipients.emails.length === 0) throw conflict('NO_RECIPIENTS', '켜져 있는 일정의 받는 사람을 모두 지울 수 없습니다. 먼저 일정을 끄세요.');
    await replaceRecipients(db, actor, s.id, input.recipients);
  }
  // 켜져 있으면 바뀐 조건으로 다음 발송 시각을 다시 계산한다.
  const next = s.is_active ? await nextRun(db, { frequency, days, send_time: sendTime, timezone }) : null;
  await db.query(
    `UPDATE app.mail_schedule
        SET name = coalesce($2, name), frequency = $3, days = $4, send_time = $5::time, timezone = $6,
            content_type = coalesce($7, content_type), skip_if_empty = coalesce($8, skip_if_empty), lang = coalesce($9, lang), next_run_at = $10
      WHERE id = $1 AND company_id = $11`,
    [s.id, input.name ?? null, frequency, days, sendTime, timezone, input.contentType ?? null, input.skipIfEmpty ?? null, input.lang ?? null, next, actor.companyId],
  );
  const { recipients, ...changes } = input;
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'MAIL_SCHEDULE_UPDATED', resource: RESOURCE, targetId: s.id,
    before: { name: s.name, frequency: s.frequency, days: s.days, sendTime: s.send_time, timezone: s.timezone, contentType: s.content_type },
    after: { ...changes, recipients: recipients ? recipients.userIds.length + recipients.emails.length : undefined }, ip: actor.auditIp,
  });
}

export async function setScheduleActive(db: Db, actor: Actor, access: DataAccess, id: string, active: boolean): Promise<void> {
  const s = await lockSchedule(db, actor, access, id);
  if (s.is_active === active) return;
  let next: Date | null = null;
  if (active) {
    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.mail_recipient WHERE schedule_id = $1 AND company_id = $2', [s.id, actor.companyId]);
    if (!count.rows[0]?.n) throw conflict('NO_RECIPIENTS', '받는 사람이 없는 일정은 켤 수 없습니다.');
    next = await nextRun(db, s);
    if (!next) throw conflict('NEVER_RUNS', '이 조건으로는 발송될 날이 없습니다. 요일·날짜를 확인하세요.');
  }
  await db.query('UPDATE app.mail_schedule SET is_active = $2, next_run_at = $3 WHERE id = $1 AND company_id = $4', [s.id, active, next, actor.companyId]);
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: active ? 'MAIL_SCHEDULE_ACTIVATED' : 'MAIL_SCHEDULE_DEACTIVATED',
    resource: RESOURCE, targetId: s.id, before: { name: s.name }, ip: actor.auditIp,
  });
}

export async function deleteSchedule(db: Db, actor: Actor, access: DataAccess, id: string): Promise<void> {
  const s = await lockSchedule(db, actor, access, id);
  const used = await db.query('SELECT 1 FROM app.mail_job WHERE schedule_id = $1 AND company_id = $2 LIMIT 1', [s.id, actor.companyId]);
  if (used.rowCount) throw conflict('IN_USE', '발송 기록이 있는 일정은 삭제할 수 없습니다. 대신 끄세요.');
  await db.query('DELETE FROM app.mail_schedule WHERE id = $1 AND company_id = $2', [s.id, actor.companyId]);
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'MAIL_SCHEDULE_DELETED', resource: RESOURCE, targetId: s.id,
    before: { name: s.name, contentType: s.content_type }, ip: actor.auditIp,
  });
}

const SQL_MAIL_LOG_COUNT = 'SELECT count(*)::int AS n FROM app.mail_log WHERE company_id = $1';
const SQL_MAIL_LOG_PAGE = 'SELECT id, job_id, recipient, subject, status, error, sent_at FROM app.mail_log WHERE company_id = $1 ORDER BY sent_at DESC, id DESC LIMIT $2 OFFSET $3';

/** 발송 기록. 받는 사람 주소가 들어 있으므로 범위 제한이 없는 사용자만 본다. */
export async function listMailLogs(db: Db, actor: Actor, access: DataAccess, query: { page?: number; pageSize?: number }) {
  if (!access.unrestricted) throw forbidden('발송 기록은 부서 범위 제한이 없는 사용자만 볼 수 있습니다.');
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const count = await db.query<{ n: number }>(SQL_MAIL_LOG_COUNT, [actor.companyId]);
  const rows = await db.query(SQL_MAIL_LOG_PAGE, [actor.companyId, pageSize, (page - 1) * pageSize]);
  return { total: count.rows[0]?.n ?? 0, page, pageSize, items: rows.rows };
}
