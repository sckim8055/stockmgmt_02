// 알림함의 응답 형식과 표시. 알림 종류와 내용(payload)의 키는 서버가 정한다
// (src/lib/alerts/thresholds.ts: LOW_STOCK·STOCK_RECOVERED, src/lib/alerts/daily.ts: WARRANTY_EXPIRING·LOAN_OVERDUE).
// 문구는 labels.text.ts 에 있다.
// 내용은 서버가 만든 JSON 이라도 화면에서는 모르는 값으로 다룬다: 키마다 형식을 확인하고, 맞지 않으면 문장을 만들지 않는다.
import { useLang, type Lang } from '../../i18n';
import { TEXT } from './labels.text';

export interface AlertItem {
  id: string;
  type: string;
  payload: unknown;
  read_at: string | null;
  created_at: string;
}

export interface AlertPage {
  total: number;
  unread: number;
  page: number;
  pageSize: number;
  items: AlertItem[];
}

export type KnownAlertType = 'LOW_STOCK' | 'STOCK_RECOVERED' | 'WARRANTY_EXPIRING' | 'LOAN_OVERDUE';

export const ALERT_TYPE_TONE: Record<KnownAlertType, 'red' | 'green' | 'amber'> = {
  LOW_STOCK: 'red',
  STOCK_RECOVERED: 'green',
  WARRANTY_EXPIRING: 'amber',
  LOAN_OVERDUE: 'red',
};

export const isKnownType = (t: string): t is KnownAlertType => Object.prototype.hasOwnProperty.call(ALERT_TYPE_TONE, t);

/** 알림 화면의 문구(현재 언어) */
export type AlertLabels = Omit<(typeof TEXT)[Lang], 'type'> & { type: Record<KnownAlertType, string> };
// 종류 이름의 키가 알림 종류와 다르면 여기서 타입 오류가 난다.
const LABELS: Record<Lang, AlertLabels> = TEXT;

export function useAlertLabels(): AlertLabels {
  return LABELS[useLang()];
}

/** 화면 안에서 갈 곳. 볼 권한이 있을 때만 링크로 그린다. */
export interface AlertLink {
  href: string;
  permission: [resource: string, operation: string];
}

export interface AlertView {
  /** null 이면 내용을 해석하지 못한 것이다(종류 코드만 보여 준다). */
  text: string | null;
  link: AlertLink | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(p: Record<string, unknown>, k: string): string | null {
  const v = p[k];
  return typeof v === 'string' && v !== '' ? v : null;
}
function num(p: Record<string, unknown>, k: string, locale: string): string | null {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString(locale) : null;
}
/** 값이 없을 수 있는 문자열(부서 = 기업 전체, 보유자 = 없음). 키는 있어야 한다. */
function optStr(p: Record<string, unknown>, k: string, fallback: string): string | null {
  const v = p[k];
  if (v === null) return fallback;
  return typeof v === 'string' && v !== '' ? v : null;
}
const assetLink = (id: string | null): AlertLink | null =>
  id && UUID.test(id) ? { href: `/assets/${encodeURIComponent(id)}`, permission: ['asset.item', 'read'] } : null;

const UNKNOWN: AlertView = { text: null, link: null };

/** 알림 내용을 현재 언어의 문장으로 만든다. T 는 useAlertLabels(), locale 은 useFmt().locale. */
export function describeAlert(T: AlertLabels, locale: string, type: string, payload: unknown): AlertView {
  const p = record(payload);
  if (!p || !isKnownType(type)) return UNKNOWN;
  switch (type) {
    case 'LOW_STOCK':
    case 'STOCK_RECOVERED': {
      const target = str(p, 'target');
      const dept = optStr(p, 'department', T.all);
      const qty = num(p, 'qty', locale);
      const min = num(p, 'minQty', locale);
      if (!target || !dept || qty === null || min === null) return UNKNOWN;
      return {
        text: (type === 'LOW_STOCK' ? T.lowStock : T.recovered)(target, dept, qty, min),
        link: { href: '/thresholds', permission: ['threshold', 'read'] },
      };
    }
    case 'WARRANTY_EXPIRING': {
      const tag = str(p, 'assetTag');
      const model = str(p, 'model');
      const end = str(p, 'warrantyEnd');
      if (!tag || !model || !end) return UNKNOWN;
      return { text: T.warranty(tag, model, end), link: assetLink(str(p, 'assetId')) };
    }
    case 'LOAN_OVERDUE': {
      const due = str(p, 'dueDate');
      const holder = optStr(p, 'holder', T.noHolder);
      if (!due || !holder) return UNKNOWN;
      // 자산 대여(assetId·assetTag) 또는 주변기기 대여(loanId·model·qty)
      const tag = str(p, 'assetTag');
      if (tag) return { text: T.assetOverdue(tag, holder, due), link: assetLink(str(p, 'assetId')) };
      const model = str(p, 'model');
      const qty = num(p, 'qty', locale);
      if (!model || qty === null) return UNKNOWN;
      return { text: T.loanOverdue(holder, model, qty, due), link: { href: '/peripherals/loans?overdue=true', permission: ['peripheral.loan', 'read'] } };
    }
  }
}
