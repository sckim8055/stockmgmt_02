// 주변기기 화면이 함께 쓰는 표시 이름. 문구는 labels.text.ts 에 있다.
import { useLang, type Lang } from '../../i18n';
import { TEXT } from './labels.text';
import type { LoanStatus, TxnType } from './types';

export interface PeripheralLabels {
  txn: Record<TxnType, string>;
  loanStatus: Record<LoanStatus, string>;
  /** 대여 현황의 상태 조건. ALL 은 서버에 그대로 넘긴다. */
  loanFilter: Record<LoanStatus | 'ALL', string>;
}

// 사전의 키가 코드와 다르면 여기서 타입 오류가 난다.
const LABELS: Record<Lang, PeripheralLabels> = TEXT;

export function peripheralLabels(lang: Lang): PeripheralLabels {
  return LABELS[lang];
}

export function usePeripheralLabels(): PeripheralLabels {
  return LABELS[useLang()];
}

/** 대화상자 제목에 쓰는 재고 이름: "제조사 모델 · 관리 부서" */
export const stockLabel = (s: { manufacturer: string; model_name: string; department_name: string }) =>
  `${s.manufacturer} ${s.model_name} · ${s.department_name}`;
