// 주변기기 화면이 함께 쓰는 표시 이름.
import type { LoanStatus, TxnType } from './types';

export const TXN_LABEL: Record<TxnType, string> = {
  INITIAL: '최초 등록',
  RECEIVE: '입고',
  ISSUE: '지급',
  LOAN: '대여',
  RETURN: '반납',
  LOAN_LOSS: '대여 분실',
  DISPOSE: '폐기',
  ADJUST: '실사 조정',
};

export const LOAN_STATUS_LABEL: Record<LoanStatus, string> = {
  OPEN: '미반납',
  CLOSED: '종료',
};

/** 대여 현황의 상태 조건. ALL 은 서버에 그대로 넘긴다. */
export const LOAN_FILTER_LABEL: Record<LoanStatus | 'ALL', string> = {
  OPEN: '미반납',
  CLOSED: '종료',
  ALL: '전체',
};

/** 부호를 붙인 수량(+3, -2) */
export const signed = (n: number) => (n > 0 ? `+${n.toLocaleString('ko-KR')}` : n.toLocaleString('ko-KR'));

export const fmtQty = (n: number) => n.toLocaleString('ko-KR');

export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('ko-KR');

/** 대화상자 제목에 쓰는 재고 이름: "제조사 모델 · 관리 부서" */
export const stockLabel = (s: { manufacturer: string; model_name: string; department_name: string }) =>
  `${s.manufacturer} ${s.model_name} · ${s.department_name}`;
