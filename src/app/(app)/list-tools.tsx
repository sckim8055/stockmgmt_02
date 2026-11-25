'use client';
// 목록 화면(자산·주변기기)이 함께 쓰는 부품: 주소창(쿼리 문자열)에 담는 조회 조건, 검색 도구줄, 두 줄 머리 표(정렬 + 열 필터), 쪽 넘김.
// 조회 조건은 모두 주소에 둔다. 새로 고치거나 주소를 나눠 줘도 같은 목록이 보인다.
// 어떤 열을 보여 줄지(권한)는 각 화면이 서버 응답을 보고 정한다. 여기서는 받은 열만 그린다.
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../ui';
import { useDebounced } from './assets/shared';
import { useT } from '../i18n';
import { TEXT } from './list-tools.text';

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
  align?: 'right';
  nowrap?: boolean;
  /** 가로로 밀어도 왼쪽에 붙어 있는 열 */
  sticky?: boolean;
}

const thBase = {
  textAlign: 'left' as const, padding: '9px 10px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)',
  fontWeight: 600, fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' as const, letterSpacing: '0.02em',
};
const tdBase = { padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'top' as const };

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

export function ListTable<R>({
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
}: {
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
}) {
  const T = useT(TEXT);
  const hasFilters = columns.some((c) => c.filter || c.filterNode);
  const cls = (c: Column<R>) => (c.sticky ? 'col-sticky' : undefined);
  return (
    <div className="table-wrap">
      <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }} data-testid={testId}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = c.sort !== undefined && c.sort === sort;
              return (
                <th
                  key={c.id}
                  scope="col"
                  className={cls(c)}
                  style={{ ...thBase, textAlign: c.align ?? 'left', ...(c.sticky ? { background: 'var(--surface-solid)' } : null) }}
                  aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
                  data-col={c.id}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      className={active ? 'text-button is-active' : 'text-button'}
                      title={T.sortBy(c.label)}
                      aria-label={active ? `${c.label} (${order === 'asc' ? T.sortAsc : T.sortDesc})` : T.sortBy(c.label)}
                      onClick={() => onSort(c.sort as string, active && order === 'asc' ? 'desc' : 'asc')}
                    >
                      {c.label}
                      <span aria-hidden="true">{active ? (order === 'asc' ? ' ▲' : ' ▼') : ' ↕'}</span>
                    </button>
                  ) : (
                    c.label
                  )}
                  {c.required === undefined ? null : <ReqMark required={c.required} />}
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
              <td colSpan={columns.length} style={{ ...tdBase, textAlign: 'center', color: 'var(--text-muted)', padding: 22 }}>{empty}</td>
            </tr>
          ) : null}
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.id} className={cls(c)} style={{ ...tdBase, textAlign: c.align ?? 'left', whiteSpace: c.nowrap ? 'nowrap' : undefined }}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    <nav aria-label={T.page(page, last)} style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 10, fontSize: 14 }}>
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

