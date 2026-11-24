// 주변기기 API 응답 형식. 서버(src/lib/peripherals/peripherals.ts)가 정한 컬럼을 그대로 옮겼다.
// (그 파일은 DB·감사 로그 모듈을 import 하므로 화면에서 직접 가져올 수 없다)

/** 서버의 MAX_QTY 와 같다. */
export const MAX_QTY = 1_000_000;

export interface StockRow {
  id: string;
  model_id: string;
  manufacturer: string;
  model_name: string;
  model_active: boolean;
  category_id: string;
  category_name: string;
  department_id: string;
  department_name: string;
  on_hand_qty: number;
  on_loan_qty: number;
  updated_at: string;
}

export interface StockPage {
  total: number;
  page: number;
  pageSize: number;
  items: StockRow[];
}

export type TxnType = 'INITIAL' | 'RECEIVE' | 'ISSUE' | 'LOAN' | 'RETURN' | 'LOAN_LOSS' | 'DISPOSE' | 'ADJUST';

export interface StockHistoryRow {
  id: string;
  type: TxnType;
  /** 보유 수량이 늘면 +, 줄면 -. 대여 분실은 대여 중 수량이 줄어든 것이라 -. */
  qty: number;
  person_id: string | null;
  person_name: string | null;
  loan_id: string | null;
  location_note: string | null;
  note: string | null;
  actor_name: string | null;
  created_at: string;
}

/** 이력 응답에는 전체 건수가 없다. */
export interface StockHistoryPage {
  page: number;
  pageSize: number;
  history: StockHistoryRow[];
}

export type LoanStatus = 'OPEN' | 'CLOSED';

export interface LoanRow {
  id: string;
  stock_id: string;
  model_id: string;
  manufacturer: string;
  model_name: string;
  department_id: string;
  department_name: string;
  person_id: string;
  person_name: string;
  person_active: boolean;
  qty: number;
  returned_qty: number;
  lost_qty: number;
  outstanding_qty: number;
  due_date: string | null;
  status: LoanStatus;
  loaned_at: string;
  closed_at: string | null;
  overdue: boolean;
}

export interface LoanPage {
  total: number;
  page: number;
  pageSize: number;
  items: LoanRow[];
}
