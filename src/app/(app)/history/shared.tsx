'use client';
// 이력 화면(재고 이력·감사 로그)이 함께 쓰는 부품.
import { useRouter, useSearchParams } from 'next/navigation';
import { smallInput } from '../../ui';
import { FilterBox } from '../peripherals/shared';
import { useT } from '../../i18n';
import { TEXT } from './shared.text';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** URL 의 조회 조건을 읽고 바꾼다. 조건을 바꾸면 첫 쪽으로 돌아간다(keepPage 제외). */
export function useUrlFilters(path: string) {
  const router = useRouter();
  const sp = useSearchParams();
  const spKey = sp.toString();
  const get = (k: string) => sp.get(k) ?? '';
  function setParams(patch: Record<string, string | null>, keepPage = false) {
    const next = new URLSearchParams(spKey);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!keepPage) next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
  }
  const reset = () => router.replace(path, { scroll: false });
  return { spKey, get, setParams, reset };
}

/** URL 의 기간 조건. 형식이 틀린 값은 없는 것으로 본다. */
export function readRange(get: (k: string) => string): { from: string; to: string; invalid: boolean } {
  const from = DATE_RE.test(get('from')) ? get('from') : '';
  const to = DATE_RE.test(get('to')) ? get('to') : '';
  return { from, to, invalid: Boolean(from && to && from > to) };
}

export function DateRangeFilter({ from, to, onChange }: { from: string; to: string; onChange: (patch: { from?: string | null; to?: string | null }) => void }) {
  const T = useT(TEXT);
  return (
    <>
      <FilterBox label={T.from}>
        {(id) => <input id={id} type="date" value={from} max={to || undefined} onChange={(e) => onChange({ from: e.target.value || null })} style={{ ...smallInput, width: 'auto', margin: 0 }} aria-describedby="history-range-hint" />}
      </FilterBox>
      <FilterBox label={T.to}>
        {(id) => <input id={id} type="date" value={to} min={from || undefined} onChange={(e) => onChange({ to: e.target.value || null })} style={{ ...smallInput, width: 'auto', margin: 0 }} aria-describedby="history-range-hint" />}
      </FilterBox>
    </>
  );
}

export function RangeHint({ invalid }: { invalid: boolean }) {
  const T = useT(TEXT);
  return (
    <p id="history-range-hint" role={invalid ? 'alert' : undefined} style={{ fontSize: 12, color: invalid ? '#b91c1c' : '#6b7280', margin: '0 0 10px' }}>
      {invalid ? T.rangeInvalid : T.rangeHint}
    </p>
  );
}
