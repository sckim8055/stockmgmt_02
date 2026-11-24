// 이력 화면(재고 이력·감사 로그)의 응답 형식과 표시 이름.
// 형식은 서버(src/lib/reports/history.ts)가 정한 컬럼을 그대로 옮겼다.
// (그 파일은 DB 모듈을 import 하므로 화면에서 직접 가져올 수 없다)
// 문구는 labels.text.ts 에 있다. 리소스 이름은 admin/resource-labels 를 쓴다.
import { useLang, type Lang } from '../../i18n';
import { assetLabels } from '../assets/labels';
import { peripheralLabels } from '../peripherals/labels';
import { TEXT } from './labels.text';

export type HistoryKind = 'ASSET' | 'PERIPHERAL';
export const HISTORY_KINDS: HistoryKind[] = ['ASSET', 'PERIPHERAL'];

export interface StockHistoryItem {
  kind: HistoryKind;
  id: string;
  seq: number | string;
  created_at: string;
  type: string;
  /** 자산이면 자산 ID, 주변기기면 재고 행 ID */
  ref_id: string;
  /** 자산 태그(주변기기는 null) */
  ref_label: string | null;
  manufacturer: string;
  model_name: string;
  department_name: string;
  /** 주변기기만: 보유 수량이 늘면 +, 줄면 - */
  qty: number | null;
  from_person: string | null;
  to_person: string | null;
  from_state: string | null;
  to_state: string | null;
  location: string | null;
  note: string | null;
  actor_name: string | null;
}

/** 이력에는 전체 건수가 없다. 한 건 더 읽어 다음 쪽이 있는지만 알려 준다. */
export interface HistoryPage<T> {
  page: number;
  pageSize: number;
  hasMore: boolean;
  items: T[];
}

export interface AuditItem {
  id: string;
  created_at: string;
  action: string;
  resource: string;
  target_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_login: string | null;
}

/** 이력 화면의 표시 이름(현재 언어) */
export interface HistoryLabels {
  kind: Record<HistoryKind, string>;
  /** 감사 로그 행위 코드 → 이름. 모르는 코드는 undefined. */
  action: Record<string, string>;
  /** 구분에 따라 고를 수 있는 종류. 구분이 없으면 둘을 합친다(같은 코드는 한 번만). */
  typeOptions: (kind: HistoryKind | '') => { value: string; label: string }[];
  typeLabel: (kind: HistoryKind, type: string) => string;
}

function build(lang: Lang): HistoryLabels {
  const t = TEXT[lang];
  const asset: Record<string, string> = assetLabels(lang).txn;
  const peripheral: Record<string, string> = peripheralLabels(lang).txn;
  const entries = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));
  return {
    kind: t.kind,
    action: t.action,
    typeOptions: (kind) => {
      if (kind === 'ASSET') return entries(asset);
      if (kind === 'PERIPHERAL') return entries(peripheral);
      const out = new Map<string, string>(Object.entries(asset));
      for (const [value, label] of Object.entries(peripheral)) {
        const prev = out.get(value);
        out.set(value, prev && prev !== label ? `${prev} / ${label}` : label);
      }
      return [...out].map(([value, label]) => ({ value, label }));
    },
    typeLabel: (kind, type) => (kind === 'ASSET' ? asset : peripheral)[type] ?? type,
  };
}

const LABELS: Record<Lang, HistoryLabels> = { ko: build('ko'), en: build('en'), zh: build('zh') };

export function useHistoryLabels(): HistoryLabels {
  return LABELS[useLang()];
}

/** 서버의 행위 조건 형식(src/app/api/history/audit/route.ts)과 같다. */
export const ACTION_PREFIX_RE = /^[A-Z_]{1,60}$/;
