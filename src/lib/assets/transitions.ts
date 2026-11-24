// 자산 상태 전이 규칙. 여기에 없는 전이는 모두 거부한다.
// DB의 CHECK 제약(asset_state_chk, asset_holder_chk)이 최종 안전망이고, 이 표가 업무 규칙이다.

export type AssetState = 'ON_ORDER' | 'IN_STOCK' | 'IN_USE' | 'MAINTENANCE' | 'MISSING' | 'RETIRED' | 'VOID';
export type AssetSubstate =
  | 'AVAILABLE' | 'RESERVED' | 'DEFECTIVE'
  | 'PENDING_DISPOSAL' | 'DISPOSED' | 'SOLD' | 'DONATED'
  | null;

export const ASSET_ACTIONS = [
  'RECEIVE', 'ASSIGN', 'LOAN', 'RETURN', 'RESERVE', 'UNRESERVE', 'MARK_DEFECTIVE',
  'REPAIR_IN', 'REPAIR_OUT', 'MARK_MISSING', 'FOUND', 'RETIRE', 'DISPOSE', 'VOID',
] as const;
export type AssetAction = (typeof ASSET_ACTIONS)[number];

/** 처리별로 필요한 권한 리소스. 지급·반납과 폐기·분실은 무게가 달라 권한을 나눈다. */
export const ACTION_RESOURCE: Record<AssetAction, 'asset.assign' | 'asset.maintain' | 'asset.retire'> = {
  ASSIGN: 'asset.assign', LOAN: 'asset.assign', RETURN: 'asset.assign',
  RECEIVE: 'asset.maintain', RESERVE: 'asset.maintain', UNRESERVE: 'asset.maintain', MARK_DEFECTIVE: 'asset.maintain',
  REPAIR_IN: 'asset.maintain', REPAIR_OUT: 'asset.maintain',
  MARK_MISSING: 'asset.retire', FOUND: 'asset.retire', RETIRE: 'asset.retire', DISPOSE: 'asset.retire', VOID: 'asset.retire',
};

export interface AssetSnapshot {
  state: AssetState;
  substate: AssetSubstate;
  holderPersonId: string | null;
}

export interface ActionInput {
  /** ASSIGN, LOAN: 받는 사람 */
  holderPersonId?: string | null;
  /** LOAN: 반납 기한(필수). ASSIGN: 쓰지 않는다. */
  dueDate?: string | null;
  /** RETURN: 불량 상태로 반납 */
  defective?: boolean;
  /** DISPOSE: 처분 방식 */
  disposal?: 'DISPOSED' | 'SOLD' | 'DONATED';
}

export interface Transition {
  state: AssetState;
  substate: AssetSubstate;
  holderPersonId: string | null;
  /** undefined = 그대로 둔다, null = 지운다 */
  dueDate?: string | null;
}

export class TransitionError extends Error {}

const stock = (substate: 'AVAILABLE' | 'RESERVED' | 'DEFECTIVE', s: AssetSnapshot) =>
  s.state === 'IN_STOCK' && s.substate === substate;
const no = (message: string): never => {
  throw new TransitionError(message);
};

/** 현재 상태에서 처리를 적용한 결과. 허용되지 않으면 TransitionError. */
export function applyAction(current: AssetSnapshot, action: AssetAction, input: ActionInput): Transition {
  const s = current;
  switch (action) {
    case 'RECEIVE':
      if (s.state !== 'ON_ORDER') no('입고 예정 상태의 자산만 입고 확정할 수 있습니다.');
      return { state: 'IN_STOCK', substate: 'AVAILABLE', holderPersonId: null };

    case 'ASSIGN':
    case 'LOAN': {
      if (!(stock('AVAILABLE', s) || stock('RESERVED', s))) no('사용 가능하거나 예약된 재고만 배정할 수 있습니다.');
      if (!input.holderPersonId) no('받는 사람을 지정해야 합니다.');
      if (action === 'LOAN' && !input.dueDate) no('대여는 반납 기한이 필요합니다.');
      return {
        state: 'IN_USE',
        substate: null,
        holderPersonId: input.holderPersonId as string,
        dueDate: action === 'LOAN' ? (input.dueDate as string) : null,
      };
    }

    case 'RETURN':
      if (s.state !== 'IN_USE') no('사용 중인 자산만 반납할 수 있습니다.');
      return { state: 'IN_STOCK', substate: input.defective ? 'DEFECTIVE' : 'AVAILABLE', holderPersonId: null, dueDate: null };

    case 'RESERVE':
      if (!stock('AVAILABLE', s)) no('사용 가능한 재고만 예약할 수 있습니다.');
      return { state: 'IN_STOCK', substate: 'RESERVED', holderPersonId: null };

    case 'UNRESERVE':
      if (!stock('RESERVED', s)) no('예약된 자산이 아닙니다.');
      return { state: 'IN_STOCK', substate: 'AVAILABLE', holderPersonId: null };

    case 'MARK_DEFECTIVE':
      if (!(stock('AVAILABLE', s) || stock('RESERVED', s))) no('재고 상태의 자산만 불량으로 표시할 수 있습니다.');
      return { state: 'IN_STOCK', substate: 'DEFECTIVE', holderPersonId: null };

    case 'REPAIR_IN':
      if (s.state !== 'IN_STOCK' && s.state !== 'IN_USE') no('재고 또는 사용 중인 자산만 수리 입고할 수 있습니다.');
      // 사용 중이던 자산은 수리가 끝나면 원래 보유자에게 돌아가도록 보유자를 유지한다.
      return { state: 'MAINTENANCE', substate: null, holderPersonId: s.holderPersonId };

    case 'REPAIR_OUT':
      if (s.state !== 'MAINTENANCE') no('수리 중인 자산이 아닙니다.');
      return s.holderPersonId
        ? { state: 'IN_USE', substate: null, holderPersonId: s.holderPersonId }
        : { state: 'IN_STOCK', substate: 'AVAILABLE', holderPersonId: null };

    case 'MARK_MISSING':
      if (s.state !== 'IN_STOCK' && s.state !== 'IN_USE' && s.state !== 'MAINTENANCE') no('이 상태에서는 분실 처리할 수 없습니다.');
      // 누가 갖고 있다가 없어졌는지 알 수 있게 보유자를 유지한다.
      return { state: 'MISSING', substate: null, holderPersonId: s.holderPersonId };

    case 'FOUND':
      if (s.state !== 'MISSING') no('분실 상태의 자산이 아닙니다.');
      return { state: 'IN_STOCK', substate: 'AVAILABLE', holderPersonId: null, dueDate: null };

    case 'RETIRE':
      if (s.state === 'IN_USE') no('사용 중인 자산은 먼저 반납 처리해야 합니다.');
      // 사용 중에 수리 보낸 자산(보유자 유지)도 같다. 수리 완료 후 반납받고 퇴역시킨다.
      // 분실 자산은 반납받을 수 없으므로 보유자가 있어도 퇴역(손실 처리)할 수 있다. 이력에 마지막 보유자가 남는다.
      if (s.state === 'MAINTENANCE' && s.holderPersonId) no('보유자가 있는 자산입니다. 수리 완료 후 반납 처리한 다음 퇴역시키세요.');
      if (s.state !== 'IN_STOCK' && s.state !== 'MAINTENANCE' && s.state !== 'MISSING') no('이 상태에서는 퇴역 처리할 수 없습니다.');
      return { state: 'RETIRED', substate: 'PENDING_DISPOSAL', holderPersonId: null, dueDate: null };

    case 'DISPOSE':
      if (!(s.state === 'RETIRED' && s.substate === 'PENDING_DISPOSAL')) no('폐기 대기 상태의 자산만 처분할 수 있습니다.');
      if (!input.disposal) no('처분 방식을 지정해야 합니다.');
      return { state: 'RETIRED', substate: input.disposal as 'DISPOSED' | 'SOLD' | 'DONATED', holderPersonId: null };

    case 'VOID':
      // 잘못 등록한 자산만 취소한다. 한 번이라도 사용된 자산의 수명 종료는 퇴역으로 처리한다.
      if (s.state !== 'ON_ORDER' && !stock('AVAILABLE', s)) no('입고 예정이거나 사용 가능한 재고만 등록 취소할 수 있습니다.');
      return { state: 'VOID', substate: null, holderPersonId: null, dueDate: null };
  }
}
