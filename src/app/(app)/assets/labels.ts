// 자산 화면이 함께 쓰는 표시 이름과 상태 규칙. 문구는 labels.text.ts 에 있다. 상태·처리 규칙 자체는 src/lib/assets/transitions.ts 가 정한다.
import type { AssetAction, AssetState } from '@/lib/assets/transitions';
import { useLang, type Lang } from '../../i18n';
import { TEXT } from './labels.text';

export type Substate = 'AVAILABLE' | 'RESERVED' | 'DEFECTIVE' | 'PENDING_DISPOSAL' | 'DISPOSED' | 'SOLD' | 'DONATED';
export type BadgeTone = 'green' | 'gray' | 'red' | 'amber' | 'blue';

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

export type Disposal = 'DISPOSED' | 'SOLD' | 'DONATED';

/** 자산 화면의 표시 이름(현재 언어) */
export interface AssetLabels {
  state: Record<AssetState, string>;
  substate: Record<Substate, string>;
  action: Record<AssetAction, string>;
  /** 이력 종류: 처리(action)에 등록·수정 같은 이력 전용 종류를 더한다. */
  txn: Record<string, string>;
  disposal: Record<Disposal, string>;
}

// 사전의 키가 상태·처리 코드와 다르면 여기서 타입 오류가 난다.
const build = (t: (typeof TEXT)[Lang]): AssetLabels => ({ ...t, txn: { ...t.action, ...t.txnExtra } });
const LABELS: Record<Lang, AssetLabels> = { ko: build(TEXT.ko), en: build(TEXT.en), zh: build(TEXT.zh) };

export function assetLabels(lang: Lang): AssetLabels {
  return LABELS[lang];
}

export function useAssetLabels(): AssetLabels {
  return LABELS[useLang()];
}

export function stateText(L: AssetLabels, state: string, substate: string | null): string {
  const s = (L.state as Record<string, string>)[state] ?? state;
  if (!substate) return s;
  return `${s} · ${(L.substate as Record<string, string>)[substate] ?? substate}`;
}
