'use client';
// 목록 화면(자산·주변기기)이 함께 쓰는 부품: 주소창(쿼리 문자열)에 담는 조회 조건, 검색 도구줄, 두 줄 머리 표(정렬 + 열 필터 + 열 너비), 쪽 넘김.
// 조회 조건은 모두 주소에 둔다. 새로 고치거나 주소를 나눠 줘도 같은 목록이 보인다.
// 어떤 열을 보여 줄지(권한)는 각 화면이 서버 응답을 보고 정한다. 여기서는 받은 열만 그린다.
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../ui';
import { useDebounced } from './assets/shared';
import { useT } from '../i18n';
import { TEXT } from './list-tools.text';
import { clampWidth, COL_DEFAULT, COL_MAX, COL_MIN, COL_STEP, useColumnWidths } from './column-widths';

/** 고를 수 있는 쪽 크기. 서버 상한(200)과 같다. "전체"는 없다. */
export const PAGE_SIZES = [20, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;
/** 열 필터 매개변수의 앞붙이(서버와 같다: f_<열>) */
export const FILTER_PARAM = 'f_';
/** 열 필터 입력이 멈춘 뒤 조회할 때까지 기다리는 시간 */
const FILTER_DEBOUNCE_MS = 500;

export function parsePageSize(raw: string): number {
  const n = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/** 주소의 조회 조건을 읽고 바꾼다. 조건을 바꾸면(쪽 이동이 아니면) 첫 쪽으로 돌아간다. */
export function useListUrl(basePath: string) {
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
    if (qs === spKey) return;
    router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
  }
  const reset = () => router.replace(basePath, { scroll: false });
  return { spKey, get, setParams, reset };
}

/**
 * 바깥(주소)의 값이 바뀌면 입력칸을 맞추되, 이 입력칸이 방금 보낸 값으로 바뀐 것이면 그대로 둔다
 * (그사이 더 친 글자를 지우지 않도록).
 */
function useSyncedInput(external: string): [string, (v: string) => void, (sent: string) => void] {
  const [value, setValue] = useState(external);
  const sent = useRef(external);
  useEffect(() => {
    if (external !== sent.current) {
      sent.current = external;
      setValue(external);
    }
  }, [external]);
  return [value, setValue, (v: string) => { sent.current = v; }];
}

// ───────────────────────── 머리 표시 ─────────────────────────

/** 머리 이름 옆의 필수/선택 표시 */
export function ReqMark({ required }: { required: boolean }) {
  const T = useT(TEXT);
  return (
    <span className={required ? 'req-mark req-mark--req' : 'req-mark'} title={required ? T.reqHint : T.optHint}>
      {required ? T.req : T.opt}
    </span>
  );
}

export interface Column<R> {
  id: string;
  label: string;
  /** 필수/선택 표시. 없으면 표시하지 않는다(작업 단추 열 등) */
  required?: boolean;
  /** 서버의 정렬 기준 이름. 없으면 정렬하지 않는 열 */
  sort?: string;
  /** 열 필터 이름(주소의 f_<이름>). 없으면 필터 칸이 비어 있다 */
  filter?: string;
  /** 글자 필터 대신 넣을 입력(예: 상태 선택) */
  filterNode?: ReactNode;
  cell: (row: R) => ReactNode;
  /**
   * 칸에 다 안 보일 때 마우스를 올리면 보여 줄 전체 값(칸의 title). 없으면 cell 이 글자·숫자를 돌려줄 때 그 값을 쓴다.
   * cell 이 요소를 돌려주면(링크·배지 등) 여기에 글자로 적는다.
   */
  title?: (row: R) => string | null | undefined;
  align?: 'right';
  /** 기본 너비(px). 사용자가 끌어서 바꾸면 그 값을 이 브라우저에 기억한다. */
  width?: number;
  /** 가로로 밀어도 왼쪽에 붙어 있는 열 */
  sticky?: boolean;
}

/** 머리 글자에 맞춰 기본 너비를 넓힐 때의 상한(아주 긴 머리 이름은 … 로 자른다) */
const HEADER_FIT_MAX = 240;

/**
 * 머리 칸이 이름·정렬 표시·필수 표시를 한 줄에 다 보이려면 필요한 너비(px). 자료와 상관없이 머리 글자(언어)에만
 * 달려 있다. 이름 칸(.th-label)만 줄어들므로, 지금 줄어든 만큼(scrollWidth - clientWidth)을 더한다.
 */
function headerFit(row: HTMLTableRowElement | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!row) return out;
  for (const th of Array.from(row.cells)) {
    const id = th.dataset.col;
    const inner = th.querySelector('.th-head__inner');
    const label = th.querySelector('.th-label');
    if (!id || !inner || !label) continue;
    const cs = getComputedStyle(th);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    out[id] = Math.ceil(inner.scrollWidth + (label.scrollWidth - label.clientWidth) + pad + 4);
  }
  return out;
}

const sameWidths = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

const thBase = {
  textAlign: 'left' as const, padding: '9px 10px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)',
  fontWeight: 600, fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' as const, letterSpacing: '0.02em',
};
const tdBase = { padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)' };

/** 열 필터 한 칸. Enter 를 누르거나 입력이 잠시 멈추면 적용한다(글자마다 조회하지 않는다). */
function FilterInput({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const T = useT(TEXT);
  const [text, setText, markSent] = useSyncedInput(value);
  const settled = useDebounced(text, FILTER_DEBOUNCE_MS);
  const commit = (v: string) => {
    const t = v.trim();
    if (t === value) return;
    markSent(t);
    onCommit(t);
  };
  useEffect(() => {
    commit(settled);
  }, [settled]);
  return (
    <input
      type="search"
      aria-label={T.filterLabel(label)}
      placeholder={T.filterPlaceholder}
      value={text}
      maxLength={100}
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(text);
        }
      }}
    />
  );
}

/** 끄는 동안 화면 전체에 붙이는 표시(글자 선택을 막고 커서를 유지한다) */
const RESIZING_CLASS = 'is-col-resizing';

/**
 * 머리 칸 오른쪽 끝의 너비 조절 손잡이. 마우스·터치로 끌거나(포인터 캡처), 초점을 두고 ←/→ 로 16px 씩,
 * Home 이나 두 번 누르기로 기본 너비. 머리의 정렬 단추와 형제라서 끌기·놓기가 정렬을 일으키지 않는다.
 */
function ColResizer({ label, width, onLive, onCommit, onStep, onReset }: {
  label: string;
  width: number;
  /** 끄는 동안(저장하지 않음) */
  onLive: (w: number) => void;
  /** 끌기를 마쳤을 때(저장) */
  onCommit: () => void;
  /** 키보드로 바꿀 때(바로 저장) */
  onStep: (w: number) => void;
  onReset: () => void;
}) {
  const T = useT(TEXT);
  const drag = useRef<{ pointer: number; x: number; w: number; moved: boolean } | null>(null);
  useEffect(() => () => document.documentElement.classList.remove(RESIZING_CLASS), []);
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.documentElement.classList.remove(RESIZING_CLASS);
    if (d.moved) onCommit();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={T.resizeColumn(label)}
      aria-valuenow={width}
      aria-valuemin={COL_MIN}
      aria-valuemax={COL_MAX}
      title={T.resizeHint}
      tabIndex={0}
      className="col-resizer"
      data-testid="col-resizer"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { pointer: e.pointerId, x: e.clientX, w: width, moved: false };
        document.documentElement.classList.add(RESIZING_CLASS);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId) return;
        const w = clampWidth(d.w + e.clientX - d.x);
        if (!d.moved && w === d.w) return;
        d.moved = true;
        onLive(w);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onStep(width + (e.key === 'ArrowRight' ? COL_STEP : -COL_STEP));
        } else if (e.key === 'Home') {
          e.preventDefault();
          onReset();
        }
      }}
    />
  );
}

/**
 * 목록 표. 한 행은 언제나 한 줄이다(넘치는 글자는 … 로 자르고 칸의 title 에 전체 값). 열 너비는 고정 배치(colgroup)라
 * 자료·필터·쪽이 바뀌어도 움직이지 않고, 머리 오른쪽 끝을 끌어 바꿀 수 있다(목록마다 이 브라우저에 기억).
 * 표는 열 너비의 합만큼 넓고, 바깥 상자 안에서 가로로 민다.
 */
export function ListTable<R>({
  listKey,
  caption,
  columns,
  rows,
  rowKey,
  sort,
  order,
  onSort,
  filterValue,
  onFilter,
  empty,
  testId,
  footer,
}: {
  /** 열 너비를 기억할 이름(화면마다 고정: assets, peripherals …) */
  listKey: string;
  caption: string;
  columns: Column<R>[];
  rows: R[];
  rowKey: (r: R) => string;
  sort: string;
  order: 'asc' | 'desc';
  onSort: (key: string, order: 'asc' | 'desc') => void;
  filterValue: (name: string) => string;
  onFilter: (name: string, value: string) => void;
  empty: string;
  testId?: string;
  /** 표 아래 줄의 오른쪽(쪽 넘김 등). 왼쪽에는 "열 너비 초기화"가 있다. */
  footer?: ReactNode;
}) {
  const T = useT(TEXT);
  const widths = useColumnWidths(listKey);
  const hasFilters = columns.some((c) => c.filter || c.filterNode);
  const cls = (c: Column<R>) => (c.sticky ? 'col-sticky' : undefined);
  // 기본 너비 = 열마다 정한 값. 다만 머리(이름 + 표시)가 그보다 길면 머리가 다 보이게 넓힌다(언어마다 다르다).
  // 머리 글자가 바뀔 때만 다시 잰다(자료·필터·쪽이 바뀌어도 너비는 그대로). 그리기 전에 재므로 깜박이지 않는다.
  const headRow = useRef<HTMLTableRowElement>(null);
  const [fit, setFit] = useState<Record<string, number>>({});
  const headKey = [T.req, T.opt, ...columns.map((c) => `${c.id}\u0000${c.label}\u0000${c.required ?? ''}\u0000${c.sort ? 1 : 0}`)].join('\u0001');
  useLayoutEffect(() => {
    const next = headerFit(headRow.current);
    setFit((prev) => (sameWidths(prev, next) ? prev : next));
  }, [headKey]);
  const defaultWidth = (c: Column<R>) => Math.max(clampWidth(c.width ?? COL_DEFAULT), Math.min(fit[c.id] ?? 0, HEADER_FIT_MAX));
  const w = (c: Column<R>) => widths.width(c.id, defaultWidth(c));
  // 보이는 열만 더한다(권한 때문에 없는 열은 자리를 차지하지 않는다).
  const total = columns.reduce((n, c) => n + w(c), 0);
  return (
    <>
      <div className="table-wrap">
        <table className="data-table data-table--fixed" style={{ width: total, borderCollapse: 'collapse' }} data-testid={testId} data-list={listKey}>
          <caption>{caption}</caption>
          <colgroup>
            {columns.map((c) => (
              <col key={c.id} data-col={c.id} style={{ width: w(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr ref={headRow}>
              {columns.map((c) => {
                const active = c.sort !== undefined && c.sort === sort;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    className={c.sticky ? 'col-sticky th-head' : 'th-head'}
                    style={{ ...thBase, textAlign: c.align ?? 'left', ...(c.sticky ? { background: 'var(--surface-solid)' } : null) }}
                    aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
                    data-col={c.id}
                  >
                    <span className="th-head__inner">
                      {c.sort ? (
                        <button
                          type="button"
                          className={active ? 'text-button th-sort is-active' : 'text-button th-sort'}
                          title={T.sortBy(c.label)}
                          aria-label={active ? `${c.label} (${order === 'asc' ? T.sortAsc : T.sortDesc})` : T.sortBy(c.label)}
                          onClick={() => onSort(c.sort as string, active && order === 'asc' ? 'desc' : 'asc')}
                        >
                          <span className="th-label">{c.label}</span>
                          <span className="th-sort__mark" aria-hidden="true">{active ? (order === 'asc' ? '▲' : '▼') : '↕'}</span>
                        </button>
                      ) : (
                        <span className="th-label" title={c.label}>{c.label}</span>
                      )}
                      {c.required === undefined ? null : <ReqMark required={c.required} />}
                    </span>
                    <ColResizer
                      label={c.label}
                      width={w(c)}
                      onLive={(n) => widths.set(c.id, n, false)}
                      onCommit={widths.save}
                      onStep={(n) => widths.set(c.id, n, true)}
                      onReset={() => widths.reset(c.id)}
                    />
                  </th>
                );
              })}
            </tr>
            {hasFilters ? (
              <tr className="filter-row">
                {columns.map((c) => (
                  <th key={c.id} scope="col" className={cls(c)}>
                    {c.filterNode ?? (c.filter ? <FilterInput label={c.label} value={filterValue(c.filter)} onCommit={(v) => onFilter(c.filter as string, v)} /> : null)}
                  </th>
                ))}
              </tr>
            ) : null}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="data-table__empty" style={{ ...tdBase, color: 'var(--text-muted)', padding: 22 }}>
                  <span>{empty}</span>
                </td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <tr key={rowKey(r)}>
                {columns.map((c) => {
                  const content = c.cell(r);
                  const title = c.title ? c.title(r) : typeof content === 'string' || typeof content === 'number' ? String(content) : undefined;
                  return (
                    <td key={c.id} className={cls(c)} style={{ ...tdBase, textAlign: c.align ?? 'left' }} title={title || undefined}>
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="list-table__foot">
        <Button small onClick={widths.resetAll} title={T.resetWidthsHint} data-testid="reset-col-widths">{T.resetWidths}</Button>
        {footer}
      </div>
    </>
  );
}

// ───────────────────────── 도구줄 ─────────────────────────

export interface FieldOption {
  value: string;
  label: string;
}

/** 필드 선택 + 검색어 + 검색·초기화 + 쪽 크기 + 전체 건수 */
export function SearchToolbar({
  fields,
  field,
  q,
  onSearch,
  onReset,
  pageSize,
  onPageSize,
  total,
}: {
  fields: FieldOption[];
  field: string;
  q: string;
  onSearch: (field: string, q: string) => void;
  onReset: () => void;
  pageSize: number;
  onPageSize: (n: number) => void;
  total: number | null;
}) {
  const T = useT(TEXT);
  const fieldId = useId();
  const textId = useId();
  const sizeId = useId();
  const [text, setText] = useSyncedInput(q);
  const [chosen, setChosen] = useSyncedInput(field);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSearch(chosen, text.trim());
  };
  return (
    <form className="list-toolbar" role="search" onSubmit={submit} data-testid="list-toolbar">
      <label htmlFor={fieldId} className="sr-only">{T.searchField}</label>
      <select id={fieldId} value={chosen} onChange={(e) => setChosen(e.target.value)} data-testid="search-field">
        <option value="all">{T.allFields}</option>
        {fields.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>
      <label htmlFor={textId} className="sr-only">{T.searchText}</label>
      <input id={textId} type="search" className="list-toolbar__search" value={text} maxLength={100} onChange={(e) => setText(e.target.value)} data-testid="search-text" />
      <Button type="submit" small variant="primary">{T.search}</Button>
      <Button small onClick={onReset} title={T.resetHint} data-testid="list-reset">{T.reset}</Button>
      <span className="list-toolbar__size">
        <label htmlFor={sizeId}>{T.pageSize}</label>
        <select id={sizeId} value={String(pageSize)} onChange={(e) => onPageSize(Number(e.target.value))} data-testid="page-size">
          {PAGE_SIZES.map((n) => (
            <option key={n} value={String(n)}>{T.pageSizeOption(n)}</option>
          ))}
        </select>
      </span>
      {total !== null ? <span className="list-toolbar__total" role="status" data-testid="list-total">{T.total(total)}</span> : null}
    </form>
  );
}

export function ListPager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const T = useT(TEXT);
  const last = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav aria-label={T.page(page, last)} style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginLeft: 'auto', fontSize: 14 }}>
      <Button small disabled={page <= 1} onClick={() => onPage(page - 1)}>{T.prev}</Button>
      <span>{T.page(page, last)}</span>
      <Button small disabled={page >= last} onClick={() => onPage(page + 1)}>{T.next}</Button>
    </nav>
  );
}

/** 주소의 조건을 API 주소로 옮긴다. 허용한 키와 열 필터(f_)만 넘긴다. */
export function apiQuery(spKey: string, keys: readonly string[], pageSize: number): string {
  const from = new URLSearchParams(spKey);
  const params = new URLSearchParams({ pageSize: String(pageSize) });
  for (const k of keys) {
    const v = from.get(k);
    if (v) params.set(k, v);
  }
  for (const [k, v] of from) if (k.startsWith(FILTER_PARAM) && v) params.set(k, v);
  return params.toString();
}

