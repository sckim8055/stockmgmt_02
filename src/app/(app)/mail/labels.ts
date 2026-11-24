// 메일 화면(일정·발송 기록)의 응답 형식과 표시 이름.
// 형식은 서버(src/lib/mail/schedules.ts, content.ts)와 입력 규칙(src/app/api/mail/schedules/schema.ts)을 그대로 옮겼다.
// (그 파일들은 DB·감사 로그 모듈을 import 하므로 화면에서 직접 가져올 수 없다)

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
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 발송 기능이 아직 없음을 알리는 문구. 일정·발송 기록 화면이 함께 쓴다. */
export const SENDING_DISABLED =
  '메일 발송 기능은 아직 켜져 있지 않습니다. 일정을 만들고 미리 볼 수는 있지만, 정기 발송기가 켜지기 전까지는 어떤 메일도 실제로 발송되지 않습니다.';

export const CONTENT_LABEL: Record<ContentType, string> = {
  LOW_STOCK: '재고 부족',
  STOCK_SUMMARY: '재고 현황',
  OPEN_LOANS: '미반납 대여',
};

export const CONTENT_HINT: Record<ContentType, string> = {
  LOW_STOCK: '지금 부족 상태인 한계 수량 목록',
  STOCK_SUMMARY: '카테고리별 사용 가능·사용 중 수량',
  OPEN_LOANS: '반납하지 않은 자산·주변기기 대여 목록(기한 지난 것 표시)',
};

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  DAILY: '매일',
  WEEKLY: '매주',
  MONTHLY: '매월',
};

export const LANG_LABEL: Record<MailLang, string> = {
  ko: '한국어',
  en: 'English',
  zh: '中文',
};

/** 1=월 … 7=일 (ISO 요일) */
export const WEEKDAY_LABEL: Record<number, string> = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };

export const TIMEZONE_LABEL: Record<string, string> = {
  'Asia/Seoul': '한국 (Asia/Seoul)',
  'Asia/Shanghai': '중국 (Asia/Shanghai)',
  'Asia/Tokyo': '일본 (Asia/Tokyo)',
  UTC: '협정 세계시 (UTC)',
};
export const DEFAULT_TIMEZONE = 'Asia/Seoul';

export const LOG_STATUS_LABEL: Record<MailLogStatus, string> = {
  SENT: '발송됨',
  FAILED: '실패',
};

/** "매일 09:00", "매주 월·수 09:00", "매월 1·15일 09:00" */
export function frequencyPhrase(s: { frequency: Frequency; days: number[]; send_time: string }): string {
  const days = [...s.days].sort((a, b) => a - b);
  if (s.frequency === 'WEEKLY') return `${FREQUENCY_LABEL.WEEKLY} ${days.map((d) => WEEKDAY_LABEL[d] ?? String(d)).join('·')} ${s.send_time}`;
  if (s.frequency === 'MONTHLY') return `${FREQUENCY_LABEL.MONTHLY} ${days.join('·')}일 ${s.send_time}`;
  return `${FREQUENCY_LABEL.DAILY} ${s.send_time}`;
}
