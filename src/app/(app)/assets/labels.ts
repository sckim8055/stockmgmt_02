// 자산 화면이 함께 쓰는 표시 이름. 상태·처리 규칙 자체는 src/lib/assets/transitions.ts 가 정한다.
import type { AssetAction, AssetState } from '@/lib/assets/transitions';

export type Substate = 'AVAILABLE' | 'RESERVED' | 'DEFECTIVE' | 'PENDING_DISPOSAL' | 'DISPOSED' | 'SOLD' | 'DONATED';
export type BadgeTone = 'green' | 'gray' | 'red' | 'amber' | 'blue';

export const STATE_LABEL: Record<AssetState, string> = {
  ON_ORDER: '입고 예정',
  IN_STOCK: '재고',
  IN_USE: '사용 중',
  MAINTENANCE: '수리 중',
  MISSING: '분실',
  RETIRED: '퇴역',
  VOID: '등록 취소',
};

export const SUBSTATE_LABEL: Record<Substate, string> = {
  AVAILABLE: '사용 가능',
  RESERVED: '예약됨',
  DEFECTIVE: '불량',
  PENDING_DISPOSAL: '폐기 대기',
  DISPOSED: '폐기됨',
  SOLD: '매각됨',
  DONATED: '기증됨',
};

/** 상태별로 고를 수 있는 세부 상태(DB 제약 asset_state_chk 와 같은 조합). */
export const STATE_SUBSTATES: Record<AssetState, Substate[]> = {
  ON_ORDER: [],
  IN_STOCK: ['AVAILABLE', 'RESERVED', 'DEFECTIVE'],
  IN_USE: [],
  MAINTENANCE: [],
  MISSING: [],
  RETIRED: ['PENDING_DISPOSAL', 'DISPOSED', 'SOLD', 'DONATED'],
  VOID: [],
};

export const STATE_TONE: Record<AssetState, BadgeTone> = {
  ON_ORDER: 'blue',
  IN_STOCK: 'green',
  IN_USE: 'blue',
  MAINTENANCE: 'amber',
  MISSING: 'red',
  RETIRED: 'gray',
  VOID: 'gray',
};

export const ACTION_LABEL: Record<AssetAction, string> = {
  RECEIVE: '입고 확정',
  ASSIGN: '배정',
  LOAN: '대여',
  RETURN: '반납',
  RESERVE: '예약',
  UNRESERVE: '예약 해제',
  MARK_DEFECTIVE: '불량 표시',
  REPAIR_IN: '수리 입고',
  REPAIR_OUT: '수리 완료',
  MARK_MISSING: '분실 처리',
  FOUND: '발견',
  RETIRE: '퇴역',
  DISPOSE: '처분',
  VOID: '등록 취소',
};

/** 이력 종류. 처리(ACTION_LABEL)에 등록·수정 같은 이력 전용 종류를 더한다. */
export const TXN_LABEL: Record<string, string> = {
  ...ACTION_LABEL,
  REGISTER: '등록',
  UPDATE: '정보 수정',
  CHANGE_DEPARTMENT: '관리 부서 변경',
  IMPORT_UPDATE: '일괄 수정',
};

export const DISPOSAL_LABEL: Record<'DISPOSED' | 'SOLD' | 'DONATED', string> = {
  DISPOSED: '폐기',
  SOLD: '매각',
  DONATED: '기증',
};

export function stateText(state: string, substate: string | null): string {
  const s = STATE_LABEL[state as AssetState] ?? state;
  if (!substate) return s;
  return `${s} · ${SUBSTATE_LABEL[substate as Substate] ?? substate}`;
}
