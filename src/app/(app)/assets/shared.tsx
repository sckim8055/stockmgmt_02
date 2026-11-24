'use client';
// 자산 목록·상세 화면이 함께 쓰는 부품.
import { useEffect, useState } from 'react';
import { api, Badge, Button, ErrorText, LabeledField, smallInput } from '../../ui';
import type { AssetState } from '@/lib/assets/transitions';
import { STATE_TONE, stateText, useAssetLabels } from './labels';
import { useFmt } from '../../i18n/format';
import type { CustomFieldDef, PersonOption } from './types';
import { useT } from '../../i18n';
import { TEXT } from './shared.text';

// ───────────────────────── 데이터 ─────────────────────────

/** null = 불러오는 중, 'denied' = 볼 수 없음(권한 없음 등) */
export type Loaded<T> = T[] | 'denied' | null;

/** 목록 하나를 불러온다. url 이 null 이면 부르지 않고 'denied' 로 둔다(권한이 없음을 미리 아는 경우). */
export function useList<T>(url: string | null, key: string): Loaded<T> {
  const [rows, setRows] = useState<Loaded<T>>(null);
  useEffect(() => {
    if (!url) {
      setRows('denied');
      return;
    }
    let live = true;
    void (async () => {
      const r = await api<Record<string, T[] | undefined>>('GET', url);
      if (!live) return;
      if (r.ok) setRows(r.data[key] ?? []);
      else if (!r.redirected) setRows('denied');
    })();
    return () => {
      live = false;
    };
  }, [url, key]);
  return rows;
}

export const listOf = <T,>(l: Loaded<T>): T[] => (Array.isArray(l) ? l : []);

export function useDebounced<V>(value: V, ms: number): V {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ───────────────────────── 표시 ─────────────────────────

export function StateBadge({ state, substate }: { state: AssetState; substate: string | null }) {
  const L = useAssetLabels();
  return <Badge tone={STATE_TONE[state] ?? 'gray'}>{stateText(L, state, substate)}</Badge>;
}

/** 오늘 날짜(브라우저 기준) YYYY-MM-DD */
export function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const isOverdue = (due: string | null) => due !== null && due < todayIso();

export const modelLabel = (m: { manufacturer: string; name: string }) => `${m.manufacturer} ${m.name}`;

// ───────────────────────── 입력 ─────────────────────────

export interface Option {
  value: string;
  label: string;
}

/** 항목이 많은 선택 상자. 위의 입력칸으로 목록을 좁힌다. id 는 선택 상자에 붙는다. */
export function FilterableSelect({
  id,
  options,
  value,
  onChange,
  required,
}: {
  id: string;
  options: Option[];
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  const T = useT(TEXT);
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  // 고른 항목은 걸러져도 남겨 둔다(선택이 보이지 않게 사라지지 않도록).
  const shown = options.filter((o) => o.value === value || !f || o.label.toLowerCase().includes(f));
  return (
    <div>
      <input
        type="search"
        aria-label={T.filterPlaceholder}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={T.filterPlaceholder}
        autoComplete="off"
        style={{ ...smallInput, marginBottom: 4 }}
      />
      <select
        id={id}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        style={smallInput}
      >
        <option value="">{shown.length === 0 ? T.noOption : T.choose}</option>
        {shown.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

export interface PersonRef {
  id: string;
  name: string;
}

/** 직원 찾아 고르기. 직원 명부(/api/master/persons)를 검색한다. */
export function PersonPicker({
  id,
  value,
  onChange,
  activeOnly,
}: {
  id: string;
  value: PersonRef | null;
  onChange: (p: PersonRef | null) => void;
  /** 배정처럼 재직자만 고를 수 있는 경우 */
  activeOnly?: boolean;
}) {
  const T = useT(TEXT);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [results, setResults] = useState<PersonOption[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (value || !dq) {
      setResults(null);
      return;
    }
    let live = true;
    void (async () => {
      const params = new URLSearchParams({ q: dq, pageSize: '10' });
      if (!activeOnly) params.set('includeInactive', 'true');
      const r = await api<{ items: PersonOption[] }>('GET', `/api/master/persons?${params.toString()}`);
      if (!live) return;
      if (r.ok) {
        setResults(r.data.items);
        setError('');
      } else if (!r.redirected) setError(r.error.message);
    })();
    return () => {
      live = false;
    };
  }, [dq, value, activeOnly]);

  if (value) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 12px', fontSize: 14 }}>
        <span id={id}>{value.name}</span>
        <Button small onClick={() => { setQ(''); onChange(null); }}>{T.clear}</Button>
      </div>
    );
  }
  return (
    <div>
      <input
        id={id}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={T.personPlaceholder}
        maxLength={100}
        autoComplete="off"
        style={{ ...smallInput, marginBottom: 4 }}
      />
      <ErrorText>{error}</ErrorText>
      {dq && results === null && !error ? <div style={{ fontSize: 13, color: '#6b7280' }}>{T.searching}</div> : null}
      {results && results.length === 0 ? <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>{T.noPerson}</div> : null}
      {results && results.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', border: '1px solid #e2e5ea', borderRadius: 6, maxHeight: 200, overflowY: 'auto' }}>
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onChange({ id: p.id, name: p.name })}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: 0, background: '#fff', cursor: 'pointer', fontSize: 14 }}
              >
                {p.name}
                <span style={{ color: '#6b7280', fontSize: 12 }}>
                  {p.employee_no ? ` · ${p.employee_no}` : ''}
                  {p.department_name ? ` · ${p.department_name}` : ''}
                  {p.is_active ? '' : ` ${T.inactive}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ───────────────────────── 사용자 지정 필드 ─────────────────────────

/** 입력 중인 값. 예/아니오는 'true' | 'false', 비어 있으면 ''. */
export type CustomDraft = Record<string, string>;

export function draftFromValues(defs: CustomFieldDef[], values: Record<string, unknown>): CustomDraft {
  const out: CustomDraft = {};
  for (const d of defs) {
    const v = values[d.key];
    out[d.key] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

/** 입력값을 서버 형식으로 바꾼다. 빈 값은 null(= 값 지우기), 형식이 틀리면 undefined. */
export function parseCustom(def: CustomFieldDef, raw: string): unknown {
  const s = def.data_type === 'text' ? raw : raw.trim();
  if (s === '') return null;
  switch (def.data_type) {
    case 'text':
      return s;
    case 'number': {
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
    case 'boolean':
      return s === 'true';
  }
}

export function CustomFieldInputs({ defs, draft, onChange }: { defs: CustomFieldDef[]; draft: CustomDraft; onChange: (next: CustomDraft) => void }) {
  const T = useT(TEXT);
  return (
    <>
      {defs.map((d) => (
        <LabeledField key={d.key} label={`${d.label}${d.is_restricted ? ` ${T.restricted}` : ''}`}>
          {(id) => {
            const value = draft[d.key] ?? '';
            const set = (v: string) => onChange({ ...draft, [d.key]: v });
            if (d.data_type === 'boolean') {
              return (
                <select id={id} style={smallInput} value={value} onChange={(e) => set(e.target.value)}>
                  <option value="">{T.boolUnset}</option>
                  <option value="true">{T.boolYes}</option>
                  <option value="false">{T.boolNo}</option>
                </select>
              );
            }
            return (
              <input
                id={id}
                style={smallInput}
                type={d.data_type === 'number' ? 'number' : d.data_type === 'date' ? 'date' : 'text'}
                step={d.data_type === 'number' ? 'any' : undefined}
                maxLength={d.data_type === 'text' ? 500 : undefined}
                value={value}
                onChange={(e) => set(e.target.value)}
                autoComplete="off"
              />
            );
          }}
        </LabeledField>
      ))}
    </>
  );
}

/** 사용자 지정 필드 값의 표시(현재 언어) */
export function useCustomDisplay(): (v: unknown) => string {
  const T = useT(TEXT);
  const F = useFmt();
  return (v) => {
    if (typeof v === 'boolean') return v ? T.boolYes : T.boolNo;
    if (typeof v === 'number') return F.num(v);
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
}
