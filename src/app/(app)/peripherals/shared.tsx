'use client';
// 주변기기 화면(재고·대여 현황)이 함께 쓰는 부품.
import { useId, type ReactNode } from 'react';
import { Button, LabeledField, smallInput } from '../../ui';
import { MAX_QTY } from './types';
import { useT } from '../../i18n';
import { TEXT } from './shared.text';

/** 목록 위의 조건 한 칸. 라벨과 입력을 id 로 묶는다. */
export function FilterBox({ label, width, children }: { label: string; width?: number; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13, color: '#4b5563', width }}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

export const filterSelect = { ...smallInput, width: 'auto', maxWidth: 240, margin: 0 } as const;

/**
 * 쪽 넘김. total 을 모르면(이력처럼 서버가 건수를 주지 않으면) hasNext 로 다음 쪽 여부를 정한다.
 */
export function Pager({ page, total, pageSize, hasNext, onPage }: { page: number; total?: number; pageSize: number; hasNext?: boolean; onPage: (p: number) => void }) {
  const T = useT(TEXT);
  const last = total === undefined ? null : Math.max(1, Math.ceil(total / pageSize));
  const label = last === null ? T.pageOnly(page) : T.page(page, last);
  const canNext = last === null ? Boolean(hasNext) : page < last;
  return (
    <nav aria-label={label} style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 10, fontSize: 14 }}>
      <Button small disabled={page <= 1} onClick={() => onPage(page - 1)}>{T.prev}</Button>
      <span>{label}</span>
      <Button small disabled={!canNext} onClick={() => onPage(page + 1)}>{T.next}</Button>
    </nav>
  );
}

/**
 * 입력한 수량을 검사하는 함수(현재 언어의 오류 문구). 정수가 아니거나 범위를 벗어나면 오류 메시지를 돌려준다.
 * max 는 화면 안내용(서버가 최종 판정한다).
 */
export function useParseQty(): (raw: string, min: number, max: number) => { qty: number } | { error: string } {
  const T = useT(TEXT);
  return (raw, min, max) => {
    const s = raw.trim();
    if (!/^\d+$/.test(s)) return { error: T.qtyInvalid(min) };
    const qty = Number(s);
    if (qty < min) return { error: T.qtyInvalid(min) };
    if (qty > Math.min(max, MAX_QTY)) return { error: T.qtyTooMany(Math.min(max, MAX_QTY)) };
    return { qty };
  };
}

/** 정수 수량 입력 칸 */
export function QtyField({ label, value, onChange, min, max }: { label: string; value: string; onChange: (v: string) => void; min: number; max?: number }) {
  const T = useT(TEXT);
  return (
    <LabeledField label={label} hint={max !== undefined ? T.qtyHint(max) : undefined}>
      {(id) => (
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max ?? MAX_QTY}
          step={1}
          required
          style={smallInput}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </LabeledField>
  );
}

export function NoteField({ label, value, onChange, required, maxLength = 500 }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; maxLength?: number }) {
  return (
    <LabeledField label={label}>
      {(id) => (
        <textarea
          id={id}
          required={required}
          style={{ ...smallInput, minHeight: 60, fontFamily: 'inherit' }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
        />
      )}
    </LabeledField>
  );
}
