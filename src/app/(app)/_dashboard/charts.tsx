'use client';
// 대시보드 차트(직접 그린 SVG). 바깥 라이브러리를 쓰지 않는다(CSP 가 외부 자원을 막고, 의존성을 늘리지 않는다).
//  - 누를 수 있는 요소는 모두 키보드로 닿는다: HTML 단추이거나 role="button" + tabIndex=0 + Enter/Space.
//  - 마우스를 올리거나 초점이 오면 정확한 수를 말풍선으로 보여 준다. 같은 수는 aria-label 에도 있다.
//  - 차트마다 "표로 보기"로 같은 자료를 표로 볼 수 있다.
//  - 색은 globals.css 의 토큰만 쓴다(var(--state-*), var(--series-*)). 글자는 글자 토큰, 색은 표시(마크)에만.
import { useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { useT } from '../../i18n';
import { useFmt } from '../../i18n/format';
import { TEXT } from './charts.text';

// ───────────────────────── 공통 ─────────────────────────

/** 요소의 너비(px). 차트를 늘이지 않고 실제 픽셀로 그리기 위해 잰다(글자 크기가 화면 폭에 따라 변하지 않게). */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.floor(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setW(Math.floor(entries[0]!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** SVG 요소를 단추처럼(Enter/Space). onSelect 가 없으면 아무것도 붙이지 않는다. */
export function pressable(onSelect?: () => void) {
  if (!onSelect) return {};
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onSelect,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    },
  };
}

interface Tip {
  x: number;
  y: number;
  lines: string[];
}

/** 말풍선. 차트 상자(box) 안에서 위치를 잡고, 상자 밖으로 나가지 않게 한다. */
export function useTooltip() {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (el: Element, lines: string[], ev?: { clientX: number; clientY: number }) => {
    const b = box.current?.getBoundingClientRect();
    if (!b) return;
    const r = el.getBoundingClientRect();
    setTip({ x: (ev ? ev.clientX : r.left + r.width / 2) - b.left, y: (ev ? ev.clientY : r.top) - b.top, lines });
  };
  const hide = () => setTip(null);
  const bind = (lines: string[]) => ({
    onMouseEnter: (e: MouseEvent) => show(e.currentTarget, lines, e),
    onMouseMove: (e: MouseEvent) => show(e.currentTarget, lines, e),
    onMouseLeave: hide,
    onFocus: (e: FocusEvent) => show(e.currentTarget, lines),
    onBlur: hide,
  });
  const width = box.current?.clientWidth ?? 0;
  const node = tip ? (
    <div className="chart-tip" aria-hidden="true" style={{ left: Math.max(0, Math.min(tip.x - 90, width - 200)), top: Math.max(0, tip.y - 12) }}>
      {tip.lines.map((l, i) => (
        <div key={i} className={i === 0 ? 'chart-tip__title' : undefined}>{l}</div>
      ))}
    </div>
  ) : null;
  return { box, bind, node, hide };
}

/** 차트 하나를 담는 패널: 제목, 동작(목록 보기 등), 설명, 표로 보기. */
export function ChartPanel({
  title, testId, hint, actions, table, wide, busy, children,
}: {
  title: string;
  testId: string;
  hint?: ReactNode;
  actions?: ReactNode;
  table?: ReactNode;
  wide?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  const T = useT(TEXT);
  const id = useId();
  const [showTable, setShowTable] = useState(false);
  return (
    <section className={wide ? 'dash-panel dash-panel--wide' : 'dash-panel'} aria-labelledby={id} data-testid={testId} aria-busy={busy || undefined}>
      <div className="dash-panel__head">
        <h2 id={id} className="dash-panel__title">{title}</h2>
        <div className="dash-panel__actions">
          {actions}
          {table ? (
            <button type="button" className="dash-link-btn" aria-expanded={showTable} onClick={() => setShowTable((v) => !v)}>
              {showTable ? T.hideTable : T.showTable}
            </button>
          ) : null}
        </div>
      </div>
      {hint ? <p className="dash-panel__hint">{hint}</p> : null}
      {children}
      {table && showTable ? <div className="dash-table-wrap">{table}</div> : null}
    </section>
  );
}

/** 차트의 대체 표 */
export function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  const F = useFmt();
  return (
    <table className="dash-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>{head.map((h, i) => <th key={i} scope="col" style={i > 0 ? { textAlign: 'right' } : undefined}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{typeof c === 'number' ? F.num(c) : c}</td>))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface Legend {
  key: string;
  label: string;
  color: string;
}

export function LegendList({ items, label }: { items: Legend[]; label: string }) {
  return (
    <ul className="chart-legend" aria-label={label}>
      {items.map((s) => (
        <li key={s.key}>
          <span className="chart-swatch" style={{ background: s.color }} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────── 도넛 ─────────────────────────

export interface Slice {
  key: string;
  label: string;
  value: number;
  /** 범례에 수 대신 적을 글(예: "제외됨"). 있으면 조각을 그리지 않는다. */
  display?: string;
  color: string;
  pressed?: boolean;
  onSelect?: () => void;
}

const SIZE = 176;
const R_OUT = 84;
const R_IN = 54;

function arc(a0: number, a1: number): string {
  const p = (r: number, a: number) => `${(SIZE / 2 + r * Math.sin(a)).toFixed(2)} ${(SIZE / 2 - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(R_OUT, a0)} A ${R_OUT} ${R_OUT} 0 ${large} 1 ${p(R_OUT, a1)} L ${p(R_IN, a1)} A ${R_IN} ${R_IN} 0 ${large} 0 ${p(R_IN, a0)} Z`;
}

export function Donut({ label, slices, centerLabel, centerValue }: { label: string; slices: Slice[]; centerLabel: string; centerValue: string }) {
  const F = useFmt();
  const T = useT(TEXT);
  const tip = useTooltip();
  const total = slices.reduce((n, s) => n + s.value, 0);
  const shown = slices.filter((s) => s.value > 0 && s.display === undefined);
  const pct = (v: number) => (total ? `${((v / total) * 100).toLocaleString(F.locale, { maximumFractionDigits: 1 })}%` : '0%');
  const notes = slices.filter((s) => s.display !== undefined).map((s) => `${s.label} ${s.display}`);
  const summary = `${label}: ${[...shown.map((s) => `${s.label} ${F.num(s.value)} (${pct(s.value)})`), ...notes].join(', ')}`;
  let a = 0;
  return (
    <div className="donut" ref={tip.box}>
      <div className="donut__chart">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label={summary}>
          {total === 0 ? <circle cx={SIZE / 2} cy={SIZE / 2} r={(R_OUT + R_IN) / 2} fill="none" stroke="var(--chart-track)" strokeWidth={R_OUT - R_IN} /> : null}
          {shown.map((s) => {
            const a0 = a;
            const a1 = a + (s.value / total) * Math.PI * 2;
            a = a1;
            const lines = [s.label, `${F.num(s.value)} (${pct(s.value)})`, s.onSelect ? T.clickHint : T.notClickable];
            const common = {
              className: s.pressed ? 'donut__slice is-pressed' : 'donut__slice',
              fill: s.color,
              'aria-label': `${s.label}: ${F.num(s.value)} (${pct(s.value)})`,
              'aria-pressed': s.onSelect ? Boolean(s.pressed) : undefined,
              'data-key': s.key,
              ...pressable(s.onSelect),
              ...tip.bind(lines),
            };
            // 한 조각이 전부면 고리 하나(호 경로는 시작과 끝이 같으면 그려지지 않는다).
            // 색은 style 로 준다: .donut__slice 의 CSS stroke(조각 사이 테두리색)가 stroke 속성보다 우선해서 고리가 배경색으로 칠해졌다.
            return shown.length === 1 ? (
              <circle key={s.key} {...common} cx={SIZE / 2} cy={SIZE / 2} r={(R_OUT + R_IN) / 2} fill="none" strokeWidth={R_OUT - R_IN} style={{ stroke: s.color }} />
            ) : (
              <path key={s.key} {...common} d={arc(a0, a1)} />
            );
          })}
        </svg>
        <div className="donut__center" aria-hidden="true">
          <div className="donut__value">{centerValue}</div>
          <div className="donut__label">{centerLabel}</div>
        </div>
      </div>
      <ul className="donut__legend" aria-hidden="true">
        {slices.map((s) => (
          <li key={s.key} className={s.pressed ? 'is-pressed' : s.display !== undefined ? 'is-excluded' : undefined} data-legend-key={s.key}>
            <span className="chart-swatch" style={{ background: s.color }} />
            <span className="donut__legend-label">{s.label}</span>
            <span className="donut__legend-num">{s.display ?? F.num(s.value)}</span>
          </li>
        ))}
      </ul>
      {tip.node}
    </div>
  );
}

// ───────────────────────── 가로 막대(쌓기) ─────────────────────────

export interface BarRow {
  key: string;
  label: string;
  sub?: string | null;
  total: number;
  parts: Record<string, number>;
  pressed?: boolean;
  onSelect?: () => void;
  /** li 의 aria-label(요약) */
  rowLabel?: string;
  /** 누를 수 없을 때 말풍선에 붙일 설명 */
  note?: string;
}

export function StackedBars({ label, series, rows, testId }: { label: string; series: Legend[]; rows: BarRow[]; testId?: string }) {
  const F = useFmt();
  const T = useT(TEXT);
  const tip = useTooltip();
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="hbar-box" ref={tip.box}>
      <ul className="hbar-list" aria-label={label} data-testid={testId}>
        {rows.map((r) => {
          const parts = series.filter((s) => (r.parts[s.key] ?? 0) > 0);
          const detail = parts.map((s) => `${s.label} ${F.num(r.parts[s.key]!)}`);
          const name = r.sub ? `${r.label} (${r.sub})` : r.label;
          const aria = `${name}: ${T.total} ${F.num(r.total)}${detail.length ? ` — ${detail.join(', ')}` : ''}`;
          const lines = [name, `${T.total} ${F.num(r.total)}`, ...detail, r.onSelect ? T.clickHint : (r.note ?? T.notClickable)];
          let x = 0;
          const bar = (
            <>
              <span className="hbar__label" title={name}>
                {r.label}
                {r.sub ? <span className="hbar__sub"> {r.sub}</span> : null}
              </span>
              <svg className="hbar__svg" viewBox="0 0 1000 14" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                <rect x={0} y={0} width={1000} height={14} fill="var(--chart-track)" />
                {parts.map((s) => {
                  const w = ((r.parts[s.key] ?? 0) / max) * 1000;
                  const el = <rect key={s.key} x={x} y={0} width={w} height={14} fill={s.color} stroke="var(--surface-solid)" strokeWidth={2} vectorEffect="non-scaling-stroke" />;
                  x += w;
                  return el;
                })}
              </svg>
              <span className="hbar__num">{F.num(r.total)}</span>
            </>
          );
          return (
            <li key={r.key} aria-label={r.rowLabel}>
              {r.onSelect ? (
                <button type="button" className={r.pressed ? 'hbar is-pressed' : 'hbar'} aria-label={aria} aria-pressed={Boolean(r.pressed)} onClick={r.onSelect} {...tip.bind(lines)}>
                  {bar}
                </button>
              ) : (
                <div className="hbar hbar--static" role="img" tabIndex={0} aria-label={`${aria}. ${r.note ?? T.notClickable}`} {...tip.bind(lines)}>
                  {bar}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {tip.node}
    </div>
  );
}

// ───────────────────────── 세로 막대(쌓기 가능) ─────────────────────────

export interface Column {
  key: string;
  label: string;
  /** 좁을 때 쓰는 짧은 이름 */
  short?: string;
  /** 말풍선 제목(없으면 label) */
  title?: string;
  parts: Record<string, number>;
  pressed?: boolean;
  onSelect?: () => void;
  note?: string;
}

const COL_H = 150;
const AXIS_W = 34;
const LABEL_H = 22;

export function Columns({ label, series, columns, testId }: { label: string; series: Legend[]; columns: Column[]; testId?: string }) {
  const F = useFmt();
  const T = useT(TEXT);
  const tip = useTooltip();
  const [ref, width] = useWidth<HTMLDivElement>();
  const totals = columns.map((c) => series.reduce((n, s) => n + (c.parts[s.key] ?? 0), 0));
  const rawMax = Math.max(0, ...totals);
  const step = niceStep(rawMax / 3);
  const max = Math.max(step * 3, 1);
  const plotW = Math.max(0, width - AXIS_W);
  const slot = columns.length ? plotW / columns.length : 0;
  const barW = Math.max(4, Math.min(44, slot * 0.66));
  const useShort = slot < 46;
  // 아주 좁으면 이름을 몇 칸마다 하나씩만(겹치지 않게). 마지막 칸의 이름은 늘 보인다. 모든 이름은 aria-label·말풍선·표에 있다.
  const every = slot > 0 && slot < 30 ? Math.ceil(30 / slot) : 1;
  const y = (v: number) => COL_H - (v / max) * COL_H;
  const summary = `${label}: ${columns.map((c, i) => `${c.title ?? c.label} ${F.num(totals[i]!)}`).join(', ')}`;
  return (
    <div className="col-box" ref={(el) => { (tip.box as RefObject<HTMLDivElement | null>).current = el; (ref as RefObject<HTMLDivElement | null>).current = el; }}>
      {width > 0 ? (
        <svg width={width} height={COL_H + LABEL_H + 6} role="group" aria-label={summary} data-testid={testId} className="col-svg">
          {[0, 1, 2, 3].map((i) => (
            <g key={i} aria-hidden="true">
              <line x1={AXIS_W} x2={width} y1={y(step * i) + 3} y2={y(step * i) + 3} stroke="var(--border)" strokeWidth={1} />
              <text x={AXIS_W - 6} y={y(step * i) + 7} textAnchor="end" className="chart-axis">{F.num(step * i)}</text>
            </g>
          ))}
          {columns.map((c, i) => {
            const cx = AXIS_W + slot * i + slot / 2;
            let acc = 0;
            const detail = series.filter((s) => (c.parts[s.key] ?? 0) > 0).map((s) => `${s.label} ${F.num(c.parts[s.key]!)}`);
            const lines = [c.title ?? c.label, `${T.total} ${F.num(totals[i]!)}`, ...(series.length > 1 ? detail : []), c.onSelect ? T.clickHint : (c.note ?? T.notClickable)];
            const aria = `${c.title ?? c.label}: ${F.num(totals[i]!)}${series.length > 1 && detail.length ? ` — ${detail.join(', ')}` : ''}${c.onSelect ? '' : `. ${c.note ?? T.notClickable}`}`;
            return (
              <g
                key={c.key}
                className={c.pressed ? 'col is-pressed' : c.onSelect ? 'col' : 'col col--static'}
                aria-label={aria}
                aria-pressed={c.onSelect ? Boolean(c.pressed) : undefined}
                {...(c.onSelect ? pressable(c.onSelect) : { role: 'img', tabIndex: 0 })}
                {...tip.bind(lines)}
              >
                <rect x={cx - slot / 2} y={0} width={slot} height={COL_H + 3} fill="transparent" />
                {series.map((s) => {
                  const v = c.parts[s.key] ?? 0;
                  if (!v) return null;
                  const top = y(acc + v);
                  const h = y(acc) - top;
                  acc += v;
                  return <rect key={s.key} x={cx - barW / 2} y={top + 3} width={barW} height={Math.max(h, 1)} fill={s.color} stroke="var(--surface-solid)" strokeWidth={1} />;
                })}
                {(columns.length - 1 - i) % every === 0 ? (
                  <text x={cx} y={COL_H + LABEL_H} textAnchor="middle" className="chart-axis" aria-hidden="true">{useShort ? (c.short ?? c.label) : c.label}</text>
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : (
        <div style={{ height: COL_H + LABEL_H + 6 }} />
      )}
      {tip.node}
    </div>
  );
}

function niceStep(v: number): number {
  if (v <= 1) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// ───────────────────────── 작은 추이선 ─────────────────────────

export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const w = 88;
  const h = 26;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(values.length > 1 ? (i / (values.length - 1)) * (w - 4) : 0) + 2},${h - 2 - (v / max) * (h - 4)}`).join(' ');
  return (
    <svg width={w} height={h} role="img" aria-label={label} className="sparkline">
      <polyline points={pts} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
