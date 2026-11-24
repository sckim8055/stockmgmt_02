// 메일 화면(일정·발송 기록)의 응답 형식과 표시 이름.
// 형식은 서버(src/lib/mail/schedules.ts, content.ts)와 입력 규칙(src/app/api/mail/schedules/schema.ts)을 그대로 옮겼다.
// (그 파일들은 DB·감사 로그 모듈을 import 하므로 화면에서 직접 가져올 수 없다)
// 문구는 labels.text.ts 에 있다.
import { useLang, type Lang } from '../../i18n';
import { LANG_NAME } from '../../i18n/langs.text';
import { TEXT } from './labels.text';

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type ContentType = 'LOW_STOCK' | 'STOCK_SUMMARY' | 'OPEN_LOANS';
export type MailLang = 'ko' | 'en' | 'zh';

export interface ScheduleRecipient {
  /** 계정이면 계정 ID, 직접 적은 주소면 null */
  userId: string | null;
  name: string | null;
  email: string | null;
}

export interface ScheduleRow {
  id: string;
  name: string;
  frequency: Frequency;
  /** WEEKLY: 요일(1=월 … 7=일), MONTHLY: 날짜(1~31), DAILY: 빈 배열 */
  days: number[];
  /** HH:MM */
  send_time: string;
  timezone: string;
  content_type: ContentType;
  department_id: string | null;
  department_name: string | null;
  skip_if_empty: boolean;
  lang: MailLang;
  is_active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  recipients: ScheduleRecipient[];
}

export interface MailPreview {
  subject: string;
  text: string;
  html: string;
  empty: boolean;
  rows: number;
}

export type MailLogStatus = 'SENT' | 'FAILED';

export interface MailLogRow {
  id: string;
  job_id: string | null;
  recipient: string;
  subject: string | null;
  status: MailLogStatus;
  error: string | null;
  sent_at: string;
}

export interface MailLogPage {
  total: number;
  page: number;
  pageSize: number;
  items: MailLogRow[];
}

/** 서버 규칙과 같은 값(schema.ts, schedules.ts MAX_RECIPIENTS). */
export const MAX_RECIPIENTS = 50;
export const MAX_NAME = 100;
export const MAX_EMAIL = 200;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const DEFAULT_TIMEZONE = 'Asia/Seoul';
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;









/** 메일 화면의 표시 이름(현재 언어) */
export interface MailLabels {
  sendingDisabled: string;
  content: Record<ContentType, string>;
  contentHint: Record<ContentType, string>;
  frequency: Record<Frequency, string>;
  weekday: Record<number, string>;
  monthDay: (d: number) => string;
  /** 고를 수 있는 시간대와 그 이름 */
  timezone: Record<string, string>;
  logStatus: Record<MailLogStatus, string>;
  daily: (time: string) => string;
  weekly: (days: number[], time: string) => string;
  monthly: (days: number[], time: string) => string;
}

// 사전의 키가 코드와 다르면 여기서 타입 오류가 난다.
const LABELS: Record<Lang, MailLabels> = TEXT;

export function useMailLabels(): MailLabels {
  return LABELS[useLang()];
}

/** 메일 언어의 이름(그 언어로 쓴 이름) */
export const MAIL_LANG_NAME: Record<MailLang, string> = LANG_NAME;

/** "매일 09:00", "매주 월·수 09:00", "매월 1·15일 09:00" (현재 언어) */
export function frequencyPhrase(M: MailLabels, s: { frequency: Frequency; days: number[]; send_time: string }): string {
  const days = [...s.days].sort((a, b) => a - b);
  if (s.frequency === 'WEEKLY') return M.weekly(days, s.send_time);
  if (s.frequency === 'MONTHLY') return M.monthly(days, s.send_time);
  return M.daily(s.send_time);
}
