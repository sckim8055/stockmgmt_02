import { z } from 'zod';
import { EMAIL_RE, line, str } from '@/lib/validation';

const Email = str().trim().max(200).regex(EMAIL_RE, '이메일 형식이 올바르지 않습니다.');
const Recipients = z.strictObject({ userIds: z.array(z.uuid()).max(50), emails: z.array(Email).max(50) });

const fields = {
  name: line().trim().min(1).max(100),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  days: z.array(z.number().int().min(1).max(31)).max(31).optional(),
  sendTime: str().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM 형식'),
  timezone: str().trim().min(1).max(64),
  contentType: z.enum(['LOW_STOCK', 'STOCK_SUMMARY', 'OPEN_LOANS']),
  skipIfEmpty: z.boolean().optional(),
  lang: z.enum(['ko', 'en', 'zh']).optional(),
  recipients: Recipients,
};

export const ScheduleCreateBody = z.strictObject({ ...fields, departmentId: z.uuid().nullish() });
// 부서는 바꿀 수 없다.
export const ScheduleUpdateBody = z.strictObject(fields).partial();
