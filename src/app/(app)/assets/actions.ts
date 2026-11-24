// 상세 화면에 보여 줄 처리 버튼을 정한다. 규칙은 서버와 같은 src/lib/assets/transitions.ts 를 그대로 쓴다
// (그 파일은 다른 모듈을 import 하지 않는 순수 함수라 화면에서 가져와도 된다). 최종 판정은 서버가 다시 한다.
import { ACTION_RESOURCE, applyAction, ASSET_ACTIONS, TransitionError, type AssetAction, type AssetSnapshot } from '@/lib/assets/transitions';

// 상태만으로 가능한지 보려고, 입력이 필요한 처리에는 형식상 값을 채워 넣는다.
const PROBE_INPUT = { holderPersonId: 'probe', dueDate: '2000-01-01', disposal: 'DISPOSED' } as const;

/** 현재 상태에서 규칙상 가능한 처리 */
export function allowedActions(s: AssetSnapshot): AssetAction[] {
  return ASSET_ACTIONS.filter((a) => {
    try {
      applyAction(s, a, PROBE_INPUT);
      return true;
    } catch (err) {
      if (err instanceof TransitionError) return false;
      throw err;
    }
  });
}

/** 처리를 받는 API 경로. 처리마다 권한 리소스의 라우트가 정해져 있다(asset.assign → /assign 등). */
export function actionUrl(assetId: string, action: AssetAction): string {
  const resource = ACTION_RESOURCE[action];
  return `/api/assets/${encodeURIComponent(assetId)}/${resource.slice('asset.'.length)}`;
}

/** 되돌리기 어려워 한 번 더 확인받는 처리 */
export const DESTRUCTIVE: ReadonlySet<AssetAction> = new Set<AssetAction>(['RETIRE', 'DISPOSE', 'VOID', 'MARK_MISSING']);
