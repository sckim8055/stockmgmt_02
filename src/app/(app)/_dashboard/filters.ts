// 대시보드의 조건(주소의 쿼리 문자열)과, 그 조건을 각 목록 화면의 주소로 옮기는 규칙.
// 자산 패널의 조건 이름·뜻은 자산 목록(/api/assets)과 같다. 그래서 자산 목록으로는 빠짐없이 그대로 옮겨진다.
// 주변기기 목록·재고 이력은 자산의 조건을 표현할 수 없다. 옮기지 못한 조건은 leftOut 으로 돌려주고 화면이 단추에 적는다.

/** 자산 조건(대시보드 = 자산 목록). 순서는 칩을 보여 줄 순서다. */
export const ASSET_FILTER_KEYS = [
  'departmentId', 'categoryId', 'modelId', 'state', 'substate', 'eq_manufacturer', 'eq_location', 'hasHolder',
  'purchaseFrom', 'purchaseTo', 'noPurchaseDate', 'warrantyFrom', 'warrantyTo', 'noWarrantyEnd', 'active', 'blank',
] as const;
/** 대시보드 화면만의 설정(목록으로 옮기지 않는다) */
export const VIEW_KEYS = ['dimension', 'trendMonths'] as const;
/**
 * 대시보드 화면만의 켜고 끄기(기본은 켜짐). 주소에는 끈 것만 남는다: retired=include(퇴역 포함), imports=include(엑셀 업로드 포함).
 * API 의 기본값은 바뀌지 않았다(조건이 없으면 퇴역·업로드 모두 넣는다). 화면이 기본으로 active=true, excludeImports=true 를 보낸다.
 */
export const TOGGLE_KEYS = ['retired', 'imports'] as const;
export const INCLUDE = 'include';
export const CF_EQ_PREFIX = 'eq_cf.';

/** 퇴역 자산을 빼고 보는가: "퇴역 제외"가 켜져 있거나(기본), 주소에 active=true 가 직접 걸려 있다(보증 구간에서 들어온 경우). */
export const retiredExcluded = (sp: URLSearchParams): boolean => sp.get('retired') !== INCLUDE || sp.get('active') === 'true';
/** 이력 추이에서 엑셀 업로드를 빼고 보는가(기본 켜짐) */
export const importsExcluded = (sp: URLSearchParams): boolean => sp.get('imports') !== INCLUDE;

/** 주소 → 실제로 거는 조건. 켜고 끄기는 지우고, "퇴역 제외"가 켜져 있으면 active=true 를 더한다. 자산 목록·API 로 옮기는 것은 이것이다. */
export function effectiveFilters(sp: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(sp);
  for (const k of TOGGLE_KEYS) p.delete(k);
  if (retiredExcluded(sp)) p.set('active', 'true');
  return p;
}

/** "퇴역 제외"를 켜거나 끈다. 끄면 active 조건도 지운다(켜기와 끄기가 서로 되돌린다). */
export function setRetiredExcluded(sp: URLSearchParams, on: boolean): URLSearchParams {
  const p = new URLSearchParams(sp);
  p.delete('active');
  if (on) p.delete('retired');
  else p.set('retired', INCLUDE);
  return p;
}

export function setImportsExcluded(sp: URLSearchParams, on: boolean): URLSearchParams {
  const p = new URLSearchParams(sp);
  if (on) p.delete('imports');
  else p.set('imports', INCLUDE);
  return p;
}

export const isAssetFilterKey = (k: string): boolean => (ASSET_FILTER_KEYS as readonly string[]).includes(k) || k.startsWith(CF_EQ_PREFIX);

/** 주소에서 자산 조건만 남긴다(빈 값은 버린다). */
export function assetFilters(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of sp) if (v && isAssetFilterKey(k)) out.set(k, v);
  return out;
}

export const hasAnyFilter = (sp: URLSearchParams): boolean => [...assetFilters(sp).keys()].length > 0;

export const blankList = (sp: URLSearchParams): string[] => (sp.get('blank') ? sp.get('blank')!.split(',').filter(Boolean) : []);

/**
 * 조건 하나를 더한다(드릴다운). 같은 필드의 "값"과 "값 없음"은 서로 바꾼다. 날짜 범위는 이미 있는 범위와 겹치는 부분만 남긴다
 * (대시보드가 보여 준 구간의 수는 지금 조건 안에서 센 수이므로, 누른 뒤에도 같은 수가 나오게).
 */
export function addFilter(sp: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(sp);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      next.delete(k);
      continue;
    }
    if (k === 'blank') {
      next.set('blank', [...new Set([...blankList(next), v])].join(','));
      if (v === 'location') next.delete('eq_location');
      else next.delete(`eq_${v}`);
      continue;
    }
    const cur = next.get(k);
    if (cur && /From$/.test(k)) next.set(k, cur > v ? cur : v);
    else if (cur && /To$/.test(k)) next.set(k, cur < v ? cur : v);
    else next.set(k, v);
    if (k === 'eq_location') removeBlank(next, 'location');
    if (k.startsWith(CF_EQ_PREFIX)) removeBlank(next, k.slice(3));
    if (k === 'state' && patch.substate === undefined) next.delete('substate');
  }
  return next;
}

function removeBlank(sp: URLSearchParams, name: string) {
  const rest = blankList(sp).filter((b) => b !== name);
  if (rest.length) sp.set('blank', rest.join(','));
  else sp.delete('blank');
}

/** 칩 하나를 지운다. 상태를 지우면 세부 상태도, 범위의 한쪽만 지울 수도 있다. */
export function removeFilter(sp: URLSearchParams, key: string, blankName?: string): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (key === 'blank' && blankName) removeBlank(next, blankName);
  else next.delete(key);
  if (key === 'state') next.delete('substate');
  if (key === 'categoryId') next.delete('modelId');
  return next;
}

export function clearFilters(sp: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  for (const k of [...VIEW_KEYS, ...TOGGLE_KEYS]) if (sp.get(k)) next.set(k, sp.get(k)!);
  return next;
}

const qs = (p: URLSearchParams) => (p.toString() ? `?${p}` : '');

/** 자산 목록: 조건을 모두 그대로 옮긴다(extra 를 더해서). */
export function assetsHref(sp: URLSearchParams, extra: Record<string, string> = {}): string {
  const p = assetFilters(sp);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return `/assets${qs(p)}`;
}

/** 자산 조건 중 departmentId 가 아닌 것(주변기기·이력으로 옮길 수 없는 것)의 키 */
export function nonDepartmentFilters(sp: URLSearchParams): string[] {
  return [...assetFilters(sp).keys()].filter((k) => k !== 'departmentId');
}

/** 주변기기 재고 목록: 부서 조건만 옮길 수 있다. */
export function peripheralsHref(sp: URLSearchParams, extra: Record<string, string> = {}): { href: string; leftOut: string[] } {
  const p = new URLSearchParams();
  if (sp.get('departmentId')) p.set('departmentId', sp.get('departmentId')!);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return { href: `/peripherals${qs(p)}`, leftOut: nonDepartmentFilters(sp) };
}

/** 대여 목록: 부서 조건만. */
export function loansHref(sp: URLSearchParams, extra: Record<string, string> = {}): { href: string; leftOut: string[] } {
  const p = new URLSearchParams(extra);
  if (sp.get('departmentId')) p.set('departmentId', sp.get('departmentId')!);
  return { href: `/peripherals/loans${qs(p)}`, leftOut: nonDepartmentFilters(sp) };
}

/** 그달의 마지막 날 */
export function monthEnd(monthStart: string): string {
  const d = new Date(`${monthStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

/** 재고 이력: 기간·구분만 옮길 수 있다. 부서를 포함한 대시보드의 조건은 모두 빠진다(이력은 사용자의 부서 범위로만 제한된다). */
export function historyHref(sp: URLSearchParams, kind: 'ASSET' | 'PERIPHERAL', monthStart: string): { href: string; leftOut: string[] } {
  const p = new URLSearchParams({ kind, from: monthStart, to: monthEnd(monthStart) });
  return { href: `/history/stock?${p}`, leftOut: [...assetFilters(sp).keys()] };
}
