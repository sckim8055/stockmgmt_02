// 한계 수량 화면의 응답 형식과 표시 이름. 서버(src/lib/alerts/thresholds.ts)가 정한 컬럼을 그대로 옮겼다.
// (그 파일은 DB·감사 로그 모듈을 import 하므로 화면에서 직접 가져올 수 없다)
// 문구는 labels.text.ts 에 있다.
import { useLang, type Lang } from '../../i18n';
import { TEXT } from './labels.text';

export type ItemKind = 'ASSET' | 'PERIPHERAL';
export type ThresholdState = 'OK' | 'LOW';

export interface ThresholdRow {
  id: string;
  category_id: string | null;
  model_id: string | null;
  /** null = 기업 전체 */
  department_id: string | null;
  min_qty: number;
  warn_ratio: number;
  state: ThresholdState;
  is_active: boolean;
  last_alert_at: string | null;
  /** 현재 사용 가능 수량(자산은 재고·사용 가능 대수, 주변기기는 보유 수량의 합) */
  qty: number;
  target_name: string;
  kind: ItemKind;
  department_name: string | null;
}

/** 서버의 한계 수량·여유 비율 범위와 같다(src/app/api/thresholds/route.ts). */
export const MAX_MIN_QTY = 1_000_000;
export const MIN_RATIO = 1;
export const MAX_RATIO = 10;

export const KIND_TONE: Record<ItemKind, 'blue' | 'amber'> = {
  ASSET: 'blue',
  PERIPHERAL: 'amber',
};

export type TargetType = 'category' | 'model';
export const TARGET_TYPES: TargetType[] = ['category', 'model'];

/** 한계 수량 화면의 표시 이름(현재 언어) */
export interface ThresholdLabels {
  kind: Record<ItemKind, string>;
  targetType: Record<TargetType, string>;
}
// 사전의 키가 코드와 다르면 여기서 타입 오류가 난다.
const LABELS: Record<Lang, ThresholdLabels> = TEXT;

export function useThresholdLabels(): ThresholdLabels {
  return LABELS[useLang()];
}

/** 부족 알림 뒤 정상으로 돌아오는 수량. 서버의 판정(Math.ceil(min_qty × warn_ratio))과 같은 식이다. */
// 서버와 같은 값이 나오도록 정수로 계산한다(부동소수점 곱셈은 100 × 1.1 을 110 보다 크게 만든다).
export const recoverAt = (t: { min_qty: number; warn_ratio: number }) => Math.ceil((t.min_qty * Math.round(t.warn_ratio * 100)) / 100);

