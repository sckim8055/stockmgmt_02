// 목록 표의 열 너비(사용자가 끌어서 바꾼 값). 이 브라우저의 표시 설정일 뿐이다:
// 주소(쿼리 문자열)에 넣지 않고 서버에도 보내지 않는다. 목록마다(assets, peripherals …) 따로 기억한다.
// 저장 형식: localStorage['stockmgmt.colWidths.<목록>'] = JSON {"<열 id>": 너비(px), …}. 기본 너비와 다른 열만 담는다.
// 저장소를 쓸 수 없으면(사생활 보호 모드 등) 이 탭의 메모리에만 남는다.
import { useCallback, useState } from 'react';

export const COL_MIN = 60;
export const COL_MAX = 800;
/** 키보드(←/→)로 한 번에 바꾸는 너비 */
export const COL_STEP = 16;
/** 열에 기본 너비가 없을 때 */
export const COL_DEFAULT = 150;

const STORAGE_PREFIX = 'stockmgmt.colWidths.';
/** 열 id 모양(기본 열 이름 또는 cf.<사용자 정의 필드 키>). 다른 것은 읽을 때 버린다. */
const COL_ID = /^(?:[a-z][a-z0-9_]{0,39}|cf\.[a-z][a-z0-9_]{0,39})$/;
/** 저장 값 하나에 담을 열 수 상한(이상한 값이 쌓이지 않게) */
const MAX_ENTRIES = 100;

export type Widths = Record<string, number>;

export const clampWidth = (w: number): number => Math.min(COL_MAX, Math.max(COL_MIN, Math.round(w)));

/**
 * 저장된 문자열을 검사해서 읽는다. 객체가 아니면 빈 값. 열 id 모양이 아니거나, 유한한 숫자가 아니거나,
 * 최소·최대 범위 밖인 항목은 버린다. 화면에 없는 열의 값은 여기서는 남겨 두고 그릴 때 쓰지 않는다
 * (권한 때문에 잠시 안 보이는 열의 너비를 잃지 않도록).
 */
export function parseStoredWidths(raw: string | null): Widths {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Widths = {};
  let n = 0;
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
    if (n >= MAX_ENTRIES) break;
    if (!COL_ID.test(k) || typeof w !== 'number' || !Number.isFinite(w) || w < COL_MIN || w > COL_MAX) continue;
    out[k] = Math.round(w);
    n++;
  }
  return out;
}

// 저장소를 쓸 수 없을 때 이 탭 안에서만 기억한다(목록 → 너비).
const memory = new Map<string, Widths>();

function read(listKey: string): Widths {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + listKey);
    if (raw !== null) return parseStoredWidths(raw);
  } catch {
    /* 저장소를 쓸 수 없음 → 메모리 값 */
  }
  return memory.get(listKey) ?? {};
}

function write(listKey: string, widths: Widths): void {
  const empty = Object.keys(widths).length === 0;
  if (empty) memory.delete(listKey);
  else memory.set(listKey, widths);
  try {
    if (empty) window.localStorage.removeItem(STORAGE_PREFIX + listKey);
    else window.localStorage.setItem(STORAGE_PREFIX + listKey, JSON.stringify(widths));
  } catch {
    /* 저장소를 쓸 수 없음 → 메모리에만 남는다 */
  }
}

/**
 * 한 목록의 열 너비. width(id, 기본값) 로 읽고, set(id, w, 저장 여부) 로 바꾼다(끄는 동안은 저장하지 않고
 * 놓을 때 한 번 저장한다). reset(id) 는 그 열을, resetAll() 은 모든 열을 기본 너비로 돌리고 저장 값을 지운다.
 * 표는 자료를 받은 뒤 브라우저에서만 그리므로(서버 렌더링에는 없다) 첫 값을 바로 저장소에서 읽는다.
 */
export function useColumnWidths(listKey: string) {
  const [widths, setWidths] = useState<Widths>(() => (typeof window === 'undefined' ? {} : read(listKey)));

  const update = useCallback(
    (fn: (prev: Widths) => Widths, persist: boolean) => {
      setWidths((prev) => {
        const next = fn(prev);
        if (persist) write(listKey, next);
        return next;
      });
    },
    [listKey],
  );

  const set = useCallback((id: string, w: number, persist: boolean) => update((p) => ({ ...p, [id]: clampWidth(w) }), persist), [update]);
  const reset = useCallback(
    (id: string) =>
      update((p) => {
        const rest = { ...p };
        delete rest[id];
        return rest;
      }, true),
    [update],
  );
  const resetAll = useCallback(() => update(() => ({}), true), [update]);
  /** 저장소에 지금 값을 쓴다(끌기를 마칠 때) */
  const save = useCallback(() => update((p) => p, true), [update]);

  const width = (id: string, fallback: number | undefined) => widths[id] ?? clampWidth(fallback ?? COL_DEFAULT);
  const customized = (ids: string[]) => ids.some((id) => widths[id] !== undefined);
  return { width, set, reset, resetAll, save, customized };
}
