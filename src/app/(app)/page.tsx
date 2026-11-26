'use client';
// 첫 화면: 모니터링 대시보드. 조건은 모두 주소(쿼리 문자열)에 둔다 — 새로 고치거나 주소를 나눠 줘도 같은 화면이 보인다.
// 차트의 막대·조각을 누르면 조건(드릴다운)이 더해지고 모든 패널이 그 조건으로 다시 센다(교차 필터).
// "목록 보기"는 같은 조건을 자산 목록의 매개변수로 옮긴다(이름·뜻이 같다. _dashboard/filters.ts).
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShell } from '../shell';
import { api, ErrorText, Notice, useUserTypeLabel } from '../ui';
import { STATE_SUBSTATES, stateText, useAssetLabels } from './assets/labels';
import { listOf, useList } from './assets/shared';
import type { CategoryOption, DepartmentOption } from './assets/types';
import type { AssetState } from '@/lib/assets/transitions';
import { useT } from '../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../i18n/format';
import { ChartPanel, Columns, DataTable, Donut, LegendList, Sparkline, StackedBars, type BarRow, type Column, type Legend, type Slice } from './_dashboard/charts';
import {
  addFilter, assetFilters, assetsHref, blankList, CF_EQ_PREFIX, clearFilters, hasAnyFilter, historyHref, loansHref, monthEnd, peripheralsHref, removeFilter, VIEW_KEYS,
} from './_dashboard/filters';

type StateRow = { state: string; substate: string | null; n: number };
interface Group { key: string | null; label: string | null; label2: string | null; total: number; byState: Record<string, number>; available: number }
interface AttentionRow { id: string; asset_tag: string; manufacturer: string; model_name: string; holder_name: string | null; department_name: string; due_date: string | null; warranty_end: string | null }
interface DashboardData {
  today: string;
  scoped: boolean;
  labels: { category: string | null; model: string | null; department: string | null } | null;
  assets: {
    total: number;
    byState: StateRow[];
    kpi: { total: number; inUse: number; available: number; inStock: number; maintenance: number; missing: number; retired: number; onOrder: number };
    overdue: number;
    warrantySoon: number;
    warrantyWindowDays: number;
    breakdown: { dimension: string; top: number; groups: Group[]; other: { groups: number; total: number; byState: Record<string, number> } | null };
    age: { kind: 'year' | 'older' | 'newer' | 'unknown'; year: number | null; n: number; from: string | null; to: string | null }[];
    warranty: { key: string; n: number; from: string | null; to: string | null }[];
    attention: { overdue: AttentionRow[]; warranty: AttentionRow[]; missing: AttentionRow[] };
    fields: { dimensions: string[]; custom: { key: string; label: string; data_type: string }[] };
  } | null;
  trend: { months: string[]; asset: { month: string; type: string; n: number }[] | null; peripheral: { month: string; type: string; n: number }[] | null; truncated: boolean; scanCap: number } | null;
  peripherals: { onHand: number; onLoan: number; stockRows: number } | null;
  peripheralCategories: { categories: number; rows: { id: string; name: string; onHand: number; onLoan: number }[] } | null;
  loans: { open: number; overdue: number } | null;
  thresholds: { active: number; low: number } | null;
  lowStock: { id: string; category_id: string | null; model_id: string | null; department_id: string | null; min_qty: number; qty: number; target_name: string; kind: string; department_name: string | null }[] | null;
}

// 상태 색: 모든 차트에서 같은 상태는 같은 색(globals.css 의 --state-*). 순서는 도넛·쌓기 순서다.
const STATE_ORDER: AssetState[] = ['IN_USE', 'IN_STOCK', 'MAINTENANCE', 'ON_ORDER', 'MISSING', 'RETIRED'];
const STATE_COLOR: Record<string, string> = {
  IN_USE: 'var(--state-in-use)', IN_STOCK: 'var(--state-available)', MAINTENANCE: 'var(--state-maintenance)',
  ON_ORDER: 'var(--state-on-order)', MISSING: 'var(--state-missing)', RETIRED: 'var(--state-retired)',
};
const SUBSTATE_COLOR: Record<string, string> = { AVAILABLE: 'var(--state-available)', RESERVED: 'var(--state-reserved)', DEFECTIVE: 'var(--state-defective)' };

// 처리 종류 → 추이의 묶음. 색은 범주 색 순서(--series-1…7)를 묶음마다 고정한다.
const ASSET_TXN_GROUP: Record<string, string> = {
  REGISTER: 'register', RECEIVE: 'register', ASSIGN: 'assign', LOAN: 'assign', RETURN: 'return', REPAIR_IN: 'repair', REPAIR_OUT: 'repair',
  MARK_DEFECTIVE: 'repair', RETIRE: 'retire', DISPOSE: 'retire', VOID: 'retire', MARK_MISSING: 'missing', FOUND: 'missing',
};
const ASSET_GROUPS = ['register', 'assign', 'return', 'repair', 'retire', 'missing', 'other'];
const PERIPHERAL_TXN_GROUP: Record<string, string> = { INITIAL: 'receive', RECEIVE: 'receive', ISSUE: 'issue', LOAN: 'loan', RETURN: 'return', DISPOSE: 'dispose', LOAN_LOSS: 'dispose' };
const PERIPHERAL_GROUPS = ['receive', 'issue', 'loan', 'return', 'dispose', 'other'];
const SERIES = (i: number) => `var(--series-${i + 1})`;

export default function HomePage() {
  const { can, effectiveCompanyId } = useShell();
  if (effectiveCompanyId && can('dashboard', 'read')) {
    return (
      <Suspense fallback={null}>
        <Dashboard />
      </Suspense>
    );
  }
  return <Welcome />;
}

/** 대시보드 권한이 없거나 기업을 고르지 않은 경우의 첫 화면 */
function Welcome() {
  const UTL = useUserTypeLabel();
  const T = useT(TEXT);
  const { me, companies } = useShell();
  const acting = me.actingCompanyId ? companies.find((c) => c.id === me.actingCompanyId) : undefined;
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 20, marginTop: 0 }}>{T.title}</h1>
      <p>{T.welcome(me.displayName)}</p>
      <dl className="panel" style={{ display: 'grid', gridTemplateColumns: 'minmax(100px, 140px) 1fr', rowGap: 6, columnGap: 8, fontSize: 14, padding: '14px 16px' }}>
        <dt>{T.type}</dt>
        <dd style={{ margin: 0 }}>{UTL[me.userType] ?? me.userType}</dd>
        {me.userType === 'SYSTEM_ADMIN' ? (
          <>
            <dt>{T.actingCompany}</dt>
            <dd style={{ margin: 0 }}>{acting ? `${acting.name} (${acting.code})` : me.actingCompanyId ?? T.none}</dd>
          </>
        ) : (
          <>
            <dt>{T.company}</dt>
            <dd style={{ margin: 0 }}>{me.company && me.companyId ? `${me.company.name} (${me.company.code})` : '-'}</dd>
          </>
        )}
      </dl>
      {me.userType === 'SYSTEM_ADMIN' ? <Notice>{me.actingCompanyId ? T.actingNote : T.pickCompany}</Notice> : <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{T.menuHint}</p>}
    </div>
  );
}

/** 주소의 조건 중 대시보드 API 에 넘길 것(자산 조건 + 화면 설정). 모르는 이름은 넘기지 않는다(400 이 되지 않게). */
function apiParams(sp: URLSearchParams): URLSearchParams {
  const p = assetFilters(sp);
  for (const k of VIEW_KEYS) if (sp.get(k)) p.set(k, sp.get(k)!);
  return p;
}

function Dashboard() {
  const F = useFmt();
  const T = useT(TEXT);
  const { can, perms } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const spKey = search.toString();
  const sp = useMemo(() => new URLSearchParams(spKey), [spKey]);
  const apiKey = apiParams(sp).toString();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [trendKind, setTrendKind] = useState<'ASSET' | 'PERIPHERAL'>('ASSET');

  useEffect(() => {
    let live = true;
    setLoading(true);
    void (async () => {
      const r = await api<DashboardData>('GET', `/api/dashboard${apiKey ? `?${apiKey}` : ''}`);
      if (!live) return;
      setLoading(false);
      if (r.ok) {
        setData(r.data);
        setError('');
      } else if (!r.redirected) setError(r.error.message || T.loadFailed);
    })();
    return () => {
      live = false;
    };
  }, [apiKey]);

  const go = (next: URLSearchParams) => {
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  const drill = (patch: Record<string, string | null>) => go(addFilter(sp, patch));

  const link = (href: string, resource: string, children: ReactNode) => (can(resource, 'read') ? <Link href={href}>{children}</Link> : children);
  const sections = data ? [data.assets, data.peripherals, data.loans, data.thresholds].filter((s) => s !== null).length : 0;

  // 조건 칸의 선택지: 기준 정보를 읽을 수 있을 때만(못 읽으면 차트를 눌러서만 거른다).
  const showFilters = data !== null && (data.assets !== null || data.peripherals !== null || data.loans !== null || data.thresholds !== null);
  const departments = useList<DepartmentOption>(can('master.department', 'read') ? '/api/departments' : null, 'departments');
  const categories = useList<CategoryOption>(can('master.category', 'read') && can('asset.item', 'read') ? '/api/master/categories?kind=ASSET&includeInactive=true' : null, 'categories');
  const scope = perms.departmentScope;
  const deptOptions = listOf(departments).filter((d) => scope === null || scope.includes(d.id));

  const a = data?.assets ?? null;
  const fieldLabel = (key: string) => a?.fields.custom.find((c) => c.key === key)?.label ?? key;

  return (
    <div className="dashboard">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h1 className="page-header__title">{T.dashTitle}</h1>
        {data ? <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{T.asOf(data.today)}</span> : null}
        {loading && data ? <span role="status" style={{ fontSize: 13, color: 'var(--text-muted)' }}>{T.refreshing}</span> : null}
      </div>
      <ErrorText>{error}</ErrorText>
      {data === null && !error ? <p style={{ color: 'var(--text-muted)' }}>{T.loading}</p> : null}
      {data ? (
        <div className={loading ? 'dash-body is-busy' : 'dash-body'} aria-busy={loading || undefined}>
          {data.scoped ? <Notice>{T.scoped}</Notice> : null}
          {sections === 0 ? <Notice>{T.noSections}</Notice> : null}
          {showFilters ? (
            <FilterBar
              sp={sp}
              data={data}
              go={go}
              deptOptions={deptOptions}
              categories={a ? listOf(categories) : []}
              fieldLabel={fieldLabel}
            />
          ) : null}

          <div className="kpi-row">
            {a ? <AssetKpis a={a} sp={sp} drill={drill} today={data.today} trend={data.trend} /> : null}
            {data.peripherals ? (
              <Card title={T.peripherals} testId="dash-peripherals" tone="green">
                <Rows>
                  <Row label={T.onHand} value={F.num(data.peripherals.onHand)} href={peripheralsHref(sp).href} link={link} resource="peripheral.stock" />
                  <Row label={T.onLoan} value={F.num(data.peripherals.onLoan)} />
                </Rows>
              </Card>
            ) : null}
            {data.loans ? (
              <Card title={T.loans} testId="dash-loans" tone="purple">
                <Rows>
                  <Row label={T.openLoans} value={F.num(data.loans.open)} href={loansHref(sp).href} link={link} resource="peripheral.loan" />
                  <Row label={T.overdueLoans} value={F.num(data.loans.overdue)} alert={data.loans.overdue > 0} href={loansHref(sp, { overdue: 'true' }).href} link={link} resource="peripheral.loan" />
                </Rows>
              </Card>
            ) : null}
            {data.thresholds ? (
              <Card title={T.thresholds} testId="dash-thresholds" tone="amber">
                <Rows>
                  <Row label={T.activeThresholds} value={F.num(data.thresholds.active)} />
                  <Row label={T.lowThresholds} value={F.num(data.thresholds.low)} alert={data.thresholds.low > 0} href="/thresholds" link={link} resource="threshold" />
                </Rows>
              </Card>
            ) : null}
          </div>

          <div className="dash-grid">
            {a ? (
              <>
                <StatusPanel a={a} sp={sp} drill={drill} />
                <BreakdownPanel a={a} sp={sp} drill={drill} go={go} fieldLabel={fieldLabel} />
                <AgePanel a={a} sp={sp} drill={drill} />
                <WarrantyPanel a={a} sp={sp} drill={drill} today={data.today} />
              </>
            ) : null}
            {data.trend ? <TrendPanel trend={data.trend} sp={sp} go={go} kind={trendKind} setKind={setTrendKind} canHistory={can('history.stock', 'read')} /> : null}
            {data.peripheralCategories ? <PeripheralPanel data={data} sp={sp} /> : null}
            {a ? <AttentionPanel a={a} sp={sp} today={data.today} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────── 조건 칸 ─────────────────────────

function FilterBar({
  sp, data, go, deptOptions, categories, fieldLabel,
}: {
  sp: URLSearchParams;
  data: DashboardData;
  go: (next: URLSearchParams) => void;
  deptOptions: DepartmentOption[];
  categories: CategoryOption[];
  fieldLabel: (key: string) => string;
}) {
  const T = useT(TEXT);
  const F = useFmt();
  const AL = useAssetLabels();
  const set = (k: string, v: string | null) => go(addFilter(sp, k === 'categoryId' ? { categoryId: v, modelId: null } : { [k]: v }));
  const state = sp.get('state') ?? '';
  const stateValue = state ? (sp.get('substate') ? `${state}:${sp.get('substate')}` : state) : '';
  const chips = useChips(sp, data, fieldLabel);
  const a = data.assets;
  return (
    <section className="dash-filters" aria-label={T.filterBar} data-testid="dashboard-filters">
      <div className="dash-filters__controls">
        {deptOptions.length > 0 ? (
          <label className="dash-field">
            <span>{T.filterDept}</span>
            <select value={sp.get('departmentId') ?? ''} onChange={(e) => set('departmentId', e.target.value || null)} data-testid="filter-department">
              <option value="">{T.all}</option>
              {deptOptions.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ` ${T.inactive}`}</option>)}
            </select>
          </label>
        ) : null}
        {a && categories.length > 0 ? (
          <label className="dash-field">
            <span>{T.filterCategory}</span>
            <select value={sp.get('categoryId') ?? ''} onChange={(e) => set('categoryId', e.target.value || null)} data-testid="filter-category">
              <option value="">{T.all}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_active ? '' : ` ${T.inactive}`}</option>)}
            </select>
          </label>
        ) : null}
        {a ? (
          <label className="dash-field">
            <span>{T.filterState}</span>
            <select
              value={stateValue}
              data-testid="filter-state"
              onChange={(e) => {
                const [s, sub] = e.target.value.split(':');
                go(addFilter(sp, { state: s || null, substate: sub || null }));
              }}
            >
              <option value="">{T.all}</option>
              {STATE_ORDER.map((s) => [
                <option key={s} value={s}>{AL.state[s]}</option>,
                ...STATE_SUBSTATES[s].map((sub) => <option key={`${s}:${sub}`} value={`${s}:${sub}`}>{`${AL.state[s]} · ${AL.substate[sub]}`}</option>),
              ])}
            </select>
          </label>
        ) : null}
        <div className="dash-filters__actions">
          {hasAnyFilter(sp) ? <button type="button" className="btn btn--secondary btn--small" onClick={() => go(clearFilters(sp))} data-testid="filters-clear">{T.clearAll}</button> : null}
          {a ? <Link className="btn btn--primary btn--small" href={assetsHref(sp)} data-testid="dash-view-list">{T.viewAssetList(F.num(a.total))}</Link> : null}
        </div>
      </div>
      <div className="dash-chips-row">
        <span className="dash-chips-row__label">{T.activeFilters}</span>
        {chips.length === 0 ? <span className="dash-chips-row__none">{T.noFilters}</span> : null}
        <ul className="dash-chips" data-testid="filter-chips">
          {chips.map((c, i) => (
            <li key={c.id}>
              {i > 0 ? <span className="dash-chips__sep" aria-hidden="true">›</span> : null}
              <button type="button" className="filter-chip" onClick={() => go(c.remove())} aria-label={T.removeChip(`${c.name}: ${c.value}`)} data-testid={`chip-${c.id}`}>
                <span className="filter-chip__name">{c.name}:</span> {c.value} <span aria-hidden="true" className="filter-chip__x">×</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

interface Chip {
  id: string;
  name: string;
  value: string;
  remove: () => URLSearchParams;
}

/** 걸린 조건을 칩으로. 이름은 서버가 알려 준 것(labels) → 고른 목록 → "(이름 없음)" 순으로 찾는다. */
function useChips(sp: URLSearchParams, data: DashboardData, fieldLabel: (key: string) => string): Chip[] {
  const T = useT(TEXT);
  const AL = useAssetLabels();
  const out: Chip[] = [];
  const rm = (key: string, also: string[] = [], blank?: string) => () => {
    let n = removeFilter(sp, key, blank);
    for (const k of also) n = removeFilter(n, k);
    return n;
  };
  const L = data.labels;
  const dims = (k: string) => T.chip[k] ?? k;
  if (sp.get('departmentId')) out.push({ id: 'departmentId', name: dims('departmentId'), value: L?.department ?? T.unknownName, remove: rm('departmentId') });
  if (sp.get('categoryId')) out.push({ id: 'categoryId', name: dims('categoryId'), value: L?.category ?? T.unknownName, remove: rm('categoryId') });
  if (sp.get('modelId')) out.push({ id: 'modelId', name: dims('modelId'), value: L?.model ?? T.unknownName, remove: rm('modelId') });
  if (sp.get('state')) out.push({ id: 'state', name: dims('state'), value: stateText(AL, sp.get('state')!, sp.get('substate')), remove: rm('state') });
  if (sp.get('eq_manufacturer')) out.push({ id: 'eq_manufacturer', name: dims('eq_manufacturer'), value: sp.get('eq_manufacturer')!, remove: rm('eq_manufacturer') });
  if (sp.get('eq_location')) out.push({ id: 'eq_location', name: dims('eq_location'), value: sp.get('eq_location')!, remove: rm('eq_location') });
  for (const [k, v] of sp) if (k.startsWith(CF_EQ_PREFIX) && v) out.push({ id: k, name: fieldLabel(k.slice(CF_EQ_PREFIX.length)), value: v, remove: rm(k) });
  for (const b of blankList(sp)) out.push({ id: `blank-${b}`, name: b === 'location' ? dims('eq_location') : fieldLabel(b.slice(3)), value: T.chipBlank, remove: rm('blank', [], b) });
  if (sp.get('hasHolder')) out.push({ id: 'hasHolder', name: dims('hasHolder'), value: sp.get('hasHolder') === 'true' ? T.chipYes : T.chipNo, remove: rm('hasHolder') });
  const range = (from: string | null, to: string | null) => `${from ?? ''} ~ ${to ?? ''}`;
  if (sp.get('purchaseFrom') || sp.get('purchaseTo')) out.push({ id: 'purchase', name: dims('purchase'), value: range(sp.get('purchaseFrom'), sp.get('purchaseTo')), remove: rm('purchaseFrom', ['purchaseTo']) });
  if (sp.get('noPurchaseDate')) out.push({ id: 'noPurchaseDate', name: dims('purchase'), value: T.chipNone, remove: rm('noPurchaseDate') });
  if (sp.get('warrantyFrom') || sp.get('warrantyTo')) out.push({ id: 'warranty', name: dims('warranty'), value: range(sp.get('warrantyFrom'), sp.get('warrantyTo')), remove: rm('warrantyFrom', ['warrantyTo']) });
  if (sp.get('noWarrantyEnd')) out.push({ id: 'noWarrantyEnd', name: dims('warranty'), value: T.chipNone, remove: rm('noWarrantyEnd') });
  if (sp.get('active')) out.push({ id: 'active', name: dims('active'), value: T.chipActive, remove: rm('active') });
  // 빵 부스러기처럼 걸린 순서대로(주소의 매개변수 순서 = 더한 순서. 같은 이름을 다시 걸면 자리는 그대로다).
  const keys = [...sp.keys()];
  const pos = (c: Chip) => {
    const k = c.id === 'purchase' ? 'purchase' : c.id === 'warranty' ? 'warranty' : c.id.startsWith('blank-') ? 'blank' : c.id;
    const i = keys.findIndex((x) => x === k || (k === 'purchase' && x.startsWith('purchase')) || (k === 'warranty' && x.startsWith('warranty')));
    return i < 0 ? keys.length : i;
  };
  return out.map((c, i) => ({ c, i })).sort((x, y) => pos(x.c) - pos(y.c) || x.i - y.i).map((x) => x.c);
}

// ───────────────────────── 핵심 수치 ─────────────────────────

function AssetKpis({
  a, sp, drill, today, trend,
}: {
  a: NonNullable<DashboardData['assets']>;
  sp: URLSearchParams;
  drill: (p: Record<string, string | null>) => void;
  today: string;
  trend: DashboardData['trend'];
}) {
  const T = useT(TEXT);
  const F = useFmt();
  const AL = useAssetLabels();
  const st = sp.get('state');
  const sub = sp.get('substate');
  const tiles: { key: string; label: string; n: number; color: string; state: string; substate: string | null }[] = [
    { key: 'IN_USE', label: AL.state.IN_USE, n: a.kpi.inUse, color: STATE_COLOR.IN_USE!, state: 'IN_USE', substate: null },
    { key: 'AVAILABLE', label: stateText(AL, 'IN_STOCK', 'AVAILABLE'), n: a.kpi.available, color: STATE_COLOR.IN_STOCK!, state: 'IN_STOCK', substate: 'AVAILABLE' },
    { key: 'MAINTENANCE', label: AL.state.MAINTENANCE, n: a.kpi.maintenance, color: STATE_COLOR.MAINTENANCE!, state: 'MAINTENANCE', substate: null },
    { key: 'MISSING', label: AL.state.MISSING, n: a.kpi.missing, color: STATE_COLOR.MISSING!, state: 'MISSING', substate: null },
    { key: 'RETIRED', label: AL.state.RETIRED, n: a.kpi.retired, color: STATE_COLOR.RETIRED!, state: 'RETIRED', substate: null },
    { key: 'ON_ORDER', label: AL.state.ON_ORDER, n: a.kpi.onOrder, color: STATE_COLOR.ON_ORDER!, state: 'ON_ORDER', substate: null },
  ];
  const soonTo = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + a.warrantyWindowDays);
    return d.toISOString().slice(0, 10);
  })();
  const monthly = trend?.asset ? trend.months.map((m) => trend.asset!.filter((r) => r.month === m).reduce((n, r) => n + r.n, 0)) : null;
  const overdueText = <span className={a.overdue > 0 ? 'stat-num stat-num--alert' : 'stat-num'}>{F.num(a.overdue)}</span>;
  return (
    <section aria-label={T.kpiTitle} data-testid="dash-assets" className="stat-card stat-card--blue kpi-card">
      <h2 className="stat-card__title">{T.kpiTitle}</h2>
      <div className="kpi-card__body">
        <div className="kpi-hero">
          <div className="stat-card__label">{T.assetsTotal}</div>
          <div data-testid="big-value" className="stat-card__value">{F.num(a.kpi.total)}</div>
        </div>
        {/* 상태 칸: 누르면 그 상태로 거른다. 글자와 수는 한 줄 글로 읽힌다(예: "사용 중 2"). */}
        <ul className="kpi-tiles" aria-label={T.byState}>
          {tiles.map((t) => {
            const pressed = st === t.state && (t.substate ? sub === t.substate : !sub);
            return (
              <li key={t.key}>
                <button
                  type="button"
                  className={pressed ? 'kpi-tile is-pressed' : 'kpi-tile'}
                  aria-pressed={pressed}
                  title={T.kpiHint}
                  onClick={() => drill(pressed ? { state: null, substate: null } : { state: t.state, substate: t.substate })}
                  data-testid={`kpi-${t.key}`}
                >
                  <span className="kpi-tile__label"><span className="chart-swatch" style={{ background: t.color }} aria-hidden="true" />{t.label}</span>{' '}
                  <span className="kpi-tile__value">{F.num(t.n)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <dl className="stat-rows kpi-rows">
          <div style={{ display: 'contents' }}>
            <dt>{T.overdue}</dt>
            <dd>{a.overdue > 0 ? <Link href={assetsHref(sp, { overdue: 'true' })}>{overdueText}</Link> : overdueText}</dd>
          </div>
          <div style={{ display: 'contents' }}>
            <dt>{T.warrantySoon}</dt>
            <dd>
              <button
                type="button"
                className={a.warrantySoon > 0 ? 'dash-num-btn stat-num stat-num--alert' : 'dash-num-btn stat-num'}
                title={T.warrantySoonHint(a.warrantyWindowDays)}
                aria-label={`${T.warrantySoon}: ${F.num(a.warrantySoon)}. ${T.warrantySoonHint(a.warrantyWindowDays)}`}
                onClick={() => drill({ warrantyFrom: today, warrantyTo: soonTo, active: 'true' })}
                data-testid="kpi-warranty-soon"
              >
                {F.num(a.warrantySoon)}
              </button>
            </dd>
          </div>
          {monthly ? (
            <div style={{ display: 'contents' }}>
              <dt>{T.activity}</dt>
              <dd className="kpi-spark">
                <Sparkline values={monthly} label={T.activitySpark(F.num(monthly[monthly.length - 1] ?? 0))} />
                <span className="stat-num">{F.num(monthly[monthly.length - 1] ?? 0)}</span>
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

// ───────────────────────── 상태 도넛 ─────────────────────────

function StatusPanel({ a, sp, drill }: { a: NonNullable<DashboardData['assets']>; sp: URLSearchParams; drill: (p: Record<string, string | null>) => void }) {
  const T = useT(TEXT);
  const F = useFmt();
  const AL = useAssetLabels();
  const st = sp.get('state');
  const sub = sp.get('substate');
  const n = (pred: (r: StateRow) => boolean) => a.byState.filter(pred).reduce((s, r) => s + r.n, 0);
  const slices: Slice[] = [];
  for (const s of STATE_ORDER) {
    if (s === 'IN_STOCK') {
      for (const x of STATE_SUBSTATES.IN_STOCK) {
        const pressed = st === 'IN_STOCK' && sub === x;
        slices.push({
          key: `IN_STOCK:${x}`, label: stateText(AL, 'IN_STOCK', x), value: n((r) => r.state === 'IN_STOCK' && r.substate === x), color: SUBSTATE_COLOR[x]!, pressed,
          onSelect: () => drill(pressed ? { state: null, substate: null } : { state: 'IN_STOCK', substate: x }),
        });
      }
      continue;
    }
    const pressed = st === s && !sub;
    slices.push({ key: s, label: AL.state[s], value: n((r) => r.state === s), color: STATE_COLOR[s]!, pressed, onSelect: () => drill(pressed ? { state: null, substate: null } : { state: s, substate: null }) });
  }
  for (const s of slices) if (s.value === 0) delete s.onSelect;
  const total = slices.reduce((x, s) => x + s.value, 0);
  const noState = new URLSearchParams(sp);
  noState.delete('state');
  noState.delete('substate');
  return (
    <ChartPanel
      title={T.statusTitle}
      testId="dash-status"
      hint={T.statusHint}
      actions={<Link className="dash-link-btn" href={assetsHref(sp)}>{T.viewList}</Link>}
      table={<DataTable caption={T.statusTitle} head={[T.colItem, T.colCount]} rows={slices.map((s) => [s.label, s.value])} />}
    >
      <Donut label={T.statusTitle} slices={slices} centerLabel={T.statusCenter} centerValue={F.num(total)} />
    </ChartPanel>
  );
}

// ───────────────────────── 묶음별 막대 ─────────────────────────

/** 묶음 하나를 조건으로(목록과 같은 이름). tests/dashboard.test.ts 의 groupParam 과 같은 규칙. */
function groupFilter(dimension: string, key: string | null): Record<string, string> {
  switch (dimension) {
    case 'category': return { categoryId: key ?? '' };
    case 'model': return { modelId: key ?? '' };
    case 'department': return { departmentId: key ?? '' };
    case 'manufacturer': return { eq_manufacturer: key ?? '' };
    case 'holder': return { hasHolder: key ?? 'false' };
    case 'location': return key === null ? { blank: 'location' } : { eq_location: key };
    default: return key === null ? { blank: dimension } : { [`eq_${dimension}`]: key };
  }
}

function removeGroup(sp: URLSearchParams, dimension: string, key: string | null): URLSearchParams {
  let n = sp;
  for (const [k, v] of Object.entries(groupFilter(dimension, key))) n = k === 'blank' ? removeFilter(n, 'blank', v) : removeFilter(n, k);
  return n;
}

function isGroupActive(sp: URLSearchParams, dimension: string, key: string | null): boolean {
  const f = groupFilter(dimension, key);
  return Object.entries(f).every(([k, v]) => (k === 'blank' ? blankList(sp).includes(v) : sp.get(k) === v));
}

function BreakdownPanel({
  a, sp, drill, go, fieldLabel,
}: {
  a: NonNullable<DashboardData['assets']>;
  sp: URLSearchParams;
  drill: (p: Record<string, string | null>) => void;
  go: (n: URLSearchParams) => void;
  fieldLabel: (key: string) => string;
}) {
  const T = useT(TEXT);
  const F = useFmt();
  const AL = useAssetLabels();
  const b = a.breakdown;
  const dim = b.dimension;
  const series: Legend[] = STATE_ORDER.map((s) => ({ key: s, label: AL.state[s], color: STATE_COLOR[s]! }));
  const name = (g: Group) => {
    if (dim === 'holder') return g.key === 'true' ? T.holderYes : T.holderNo;
    return g.label ?? T.blankValue;
  };
  const rows: BarRow[] = b.groups.map((g) => {
    const active = isGroupActive(sp, dim, g.key);
    return {
      key: g.key ?? '__blank',
      label: name(g),
      sub: dim === 'model' ? g.label2 : null,
      total: g.total,
      parts: g.byState,
      pressed: active,
      // 이미 걸린 묶음을 다시 누르면 그 조건을 지운다.
      onSelect: () => (active ? go(removeGroup(sp, dim, g.key)) : drill(groupFilter(dim, g.key))),
      rowLabel: T.barLabel(name(g), F.num(g.available), F.num(g.byState.IN_USE ?? 0), F.num(g.total - (g.byState.RETIRED ?? 0))),
    };
  });
  if (b.other) rows.push({ key: '__other', label: T.other(F.num(b.other.groups)), total: b.other.total, parts: b.other.byState, note: T.otherNote });
  const options = [...a.fields.dimensions.map((d) => ({ value: d, label: T.dim[d] ?? d })), ...a.fields.custom.map((c) => ({ value: `cf.${c.key}`, label: c.label }))];
  const dimLabel = dim.startsWith('cf.') ? fieldLabel(dim.slice(3)) : (T.dim[dim] ?? dim);
  return (
    <ChartPanel
      title={`${T.breakdownTitle} — ${dimLabel}`}
      testId="dash-breakdown"
      hint={T.breakdownHint(b.top)}
      actions={
        <>
          <label className="dash-field dash-field--inline">
            <span>{T.breakdownBy}</span>
            <select
              value={dim}
              data-testid="breakdown-dimension"
              onChange={(e) => {
                const n = new URLSearchParams(sp);
                if (e.target.value === 'category') n.delete('dimension');
                else n.set('dimension', e.target.value);
                go(n);
              }}
            >
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <Link className="dash-link-btn" href={assetsHref(sp)}>{T.viewList}</Link>
        </>
      }
      table={
        <DataTable
          caption={T.breakdownTitle}
          head={[dimLabel, ...series.map((s) => s.label), T.colTotal]}
          rows={rows.map((r) => [r.sub ? `${r.label} (${r.sub})` : r.label, ...series.map((s) => r.parts[s.key] ?? 0), r.total])}
        />
      }
    >
      {rows.length === 0 ? <p className="dash-empty">{T.noAssets}</p> : (
        <>
          <LegendList items={series} label={T.byState} />
          <StackedBars label={`${T.breakdownTitle} — ${dimLabel}`} series={series} rows={rows} testId={dim === 'category' ? 'dash-categories' : 'dash-breakdown-list'} />
        </>
      )}
    </ChartPanel>
  );
}

// ───────────────────────── 구매 연도 ─────────────────────────

function AgePanel({ a, sp, drill }: { a: NonNullable<DashboardData['assets']>; sp: URLSearchParams; drill: (p: Record<string, string | null>) => void }) {
  const T = useT(TEXT);
  const series: Legend[] = [{ key: 'n', label: T.colCount, color: SERIES(0) }];
  const cols: Column[] = a.age.map((b) => {
    const label = b.kind === 'year' ? String(b.year) : b.kind === 'older' ? T.ageOlder(b.year!) : b.kind === 'newer' ? T.ageNewer(b.year!) : T.ageUnknown;
    const short = b.kind === 'year' ? `'${String(b.year).slice(2)}` : b.kind === 'unknown' ? T.ageUnknownShort : label;
    const patch: Record<string, string | null> = b.kind === 'unknown' ? { noPurchaseDate: 'true' } : { purchaseFrom: b.from, purchaseTo: b.to };
    const pressed = b.kind === 'unknown' ? sp.get('noPurchaseDate') === 'true' : sp.get('purchaseFrom') === b.from && sp.get('purchaseTo') === b.to && (b.from !== null || b.to !== null);
    return { key: `${b.kind}-${b.year}`, label: b.kind === 'unknown' ? T.ageUnknownShort : label, short, title: label, parts: { n: b.n }, pressed, onSelect: b.n > 0 && !pressed ? () => drill(patch) : undefined };
  });
  return (
    <ChartPanel
      title={T.ageTitle}
      testId="dash-age"
      hint={T.ageHint}
      actions={<Link className="dash-link-btn" href={assetsHref(sp)}>{T.viewList}</Link>}
      table={<DataTable caption={T.ageTitle} head={[T.colItem, T.colCount]} rows={cols.map((c) => [c.title ?? c.label, c.parts.n ?? 0])} />}
    >
      <Columns label={T.ageTitle} series={series} columns={cols} testId="age-chart" />
    </ChartPanel>
  );
}

// ───────────────────────── 보증 만료 ─────────────────────────

function WarrantyPanel({ a, sp, drill, today }: { a: NonNullable<DashboardData['assets']>; sp: URLSearchParams; drill: (p: Record<string, string | null>) => void; today: string }) {
  const T = useT(TEXT);
  const series: Legend[] = [{ key: 'n', label: T.colCount, color: SERIES(0) }];
  const cols: Column[] = a.warranty.map((b) => {
    const patch: Record<string, string | null> = b.key === 'none' ? { noWarrantyEnd: 'true', active: 'true' } : { warrantyFrom: b.from, warrantyTo: b.to, active: 'true' };
    const pressed = b.key === 'none' ? sp.get('noWarrantyEnd') === 'true' : sp.get('warrantyFrom') === b.from && sp.get('warrantyTo') === b.to;
    return { key: b.key, label: T.wbShort[b.key] ?? b.key, short: T.wbShort[b.key], title: T.wb[b.key] ?? b.key, parts: { n: b.n }, pressed, onSelect: b.n > 0 && !pressed ? () => drill(patch) : undefined };
  });
  return (
    <ChartPanel
      title={T.warrantyTitle}
      testId="dash-warranty"
      hint={T.warrantyHint(today)}
      actions={<Link className="dash-link-btn" href={assetsHref(sp, { active: 'true' })}>{T.viewList}</Link>}
      table={<DataTable caption={T.warrantyTitle} head={[T.colItem, T.colCount]} rows={cols.map((c) => [c.title ?? c.label, c.parts.n ?? 0])} />}
    >
      <Columns label={T.warrantyTitle} series={series} columns={cols} testId="warranty-chart" />
    </ChartPanel>
  );
}

// ───────────────────────── 처리 추이 ─────────────────────────

function TrendPanel({
  trend, sp, go, kind, setKind, canHistory,
}: {
  trend: NonNullable<DashboardData['trend']>;
  sp: URLSearchParams;
  go: (n: URLSearchParams) => void;
  kind: 'ASSET' | 'PERIPHERAL';
  setKind: (k: 'ASSET' | 'PERIPHERAL') => void;
  canHistory: boolean;
}) {
  const T = useT(TEXT);
  const F = useFmt();
  const router = useRouter();
  const k = kind === 'ASSET' && trend.asset ? 'ASSET' : trend.peripheral ? 'PERIPHERAL' : 'ASSET';
  const rows = (k === 'ASSET' ? trend.asset : trend.peripheral) ?? [];
  const groups = k === 'ASSET' ? ASSET_GROUPS : PERIPHERAL_GROUPS;
  const map = k === 'ASSET' ? ASSET_TXN_GROUP : PERIPHERAL_TXN_GROUP;
  const names = k === 'ASSET' ? T.tAsset : T.tPeripheral;
  const series: Legend[] = groups.map((g, i) => ({ key: g, label: names[g] ?? g, color: SERIES(i) }));
  const months = trend.months;
  const cols: Column[] = months.map((m) => {
    const parts: Record<string, number> = {};
    for (const r of rows) if (r.month === m) parts[map[r.type] ?? 'other'] = (parts[map[r.type] ?? 'other'] ?? 0) + r.n;
    const h = historyHref(sp, k, m);
    return { key: m, label: T.monthShort(m), title: T.month(m), parts, onSelect: canHistory ? () => router.push(h.href) : undefined };
  });
  const total = cols.reduce((n, c) => n + Object.values(c.parts).reduce((x, y) => x + y, 0), 0);
  const left = historyHref(sp, k, months[0]!).leftOut;
  const months3 = ['3', '6', '12'];
  const cur = sp.get('trendMonths') ?? '12';
  const viewHref = `/history/stock?${new URLSearchParams({ kind: k, from: months[0]!, to: monthEnd(months[months.length - 1]!) })}`;
  return (
    <ChartPanel
      title={T.trendTitle}
      testId="dash-trend"
      wide
      hint={
        <>
          {T.trendHint} {T.trendScopeNote}
          {left.length && hasAnyFilter(sp) ? <> <strong>{T.leftOut(left.map((x) => T.chip[x] ?? x).join(', '))}</strong></> : null}
          {trend.truncated ? <> {T.trendTruncated(F.num(trend.scanCap))}</> : null}
        </>
      }
      actions={
        <>
          {trend.asset && trend.peripheral ? (
            <div className="seg" role="group" aria-label={T.trendKind}>
              <button type="button" aria-pressed={k === 'ASSET'} onClick={() => setKind('ASSET')}>{T.trendAsset}</button>
              <button type="button" aria-pressed={k === 'PERIPHERAL'} onClick={() => setKind('PERIPHERAL')}>{T.trendPeripheral}</button>
            </div>
          ) : null}
          <div className="seg" role="group" aria-label={T.trendMonths}>
            {months3.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={cur === m}
                data-testid={`trend-${m}`}
                onClick={() => {
                  const n = new URLSearchParams(sp);
                  if (m === '12') n.delete('trendMonths');
                  else n.set('trendMonths', m);
                  go(n);
                }}
              >
                {T.monthsOpt(Number(m))}
              </button>
            ))}
          </div>
          {canHistory ? <Link className="dash-link-btn" href={viewHref}>{T.viewHistory}</Link> : null}
        </>
      }
      table={
        <DataTable
          caption={T.trendTitle}
          head={[T.colMonth, ...series.map((s) => s.label), T.colTotal]}
          rows={cols.map((c) => [c.title ?? c.label, ...series.map((s) => c.parts[s.key] ?? 0), Object.values(c.parts).reduce((x, y) => x + y, 0)])}
        />
      }
    >
      {total === 0 ? <p className="dash-empty">{T.trendEmpty}</p> : null}
      <LegendList items={series} label={T.trendTitle} />
      <Columns label={`${T.trendTitle} (${k === 'ASSET' ? T.trendAsset : T.trendPeripheral})`} series={series} columns={cols} testId="trend-chart" />
    </ChartPanel>
  );
}

// ───────────────────────── 주변기기 ─────────────────────────

function PeripheralPanel({ data, sp }: { data: DashboardData; sp: URLSearchParams }) {
  const T = useT(TEXT);
  const F = useFmt();
  const router = useRouter();
  const pc = data.peripheralCategories!;
  const series: Legend[] = [
    { key: 'onHand', label: T.onHand, color: SERIES(0) },
    { key: 'onLoan', label: T.onLoan, color: SERIES(2) },
  ];
  const rows: BarRow[] = pc.rows.map((r) => {
    const h = peripheralsHref(sp, { categoryId: r.id });
    return { key: r.id, label: r.name, total: r.onHand + r.onLoan, parts: { onHand: r.onHand, onLoan: r.onLoan }, onSelect: () => router.push(h.href) };
  });
  const list = peripheralsHref(sp);
  const lowHref = (l: NonNullable<DashboardData['lowStock']>[number]) => {
    const p = new URLSearchParams();
    if (l.model_id) p.set('modelId', l.model_id);
    if (l.category_id) p.set('categoryId', l.category_id);
    if (l.department_id) p.set('departmentId', l.department_id);
    if (l.kind === 'ASSET') {
      p.set('state', 'IN_STOCK');
      p.set('substate', 'AVAILABLE');
      return `/assets?${p}`;
    }
    return `/peripherals?${p}`;
  };
  return (
    <ChartPanel
      title={T.periphTitle}
      testId="dash-periph"
      hint={
        <>
          {T.periphHint} {T.deptOnly}
          {list.leftOut.length ? <> <strong>{T.leftOut(list.leftOut.map((x) => T.chip[x] ?? x).join(', '))}</strong></> : null}
        </>
      }
      actions={<Link className="dash-link-btn" href={list.href}>{T.viewPeripheralList}</Link>}
      table={<DataTable caption={T.periphTitle} head={[T.colItem, T.onHand, T.onLoan]} rows={pc.rows.map((r) => [r.name, r.onHand, r.onLoan])} />}
    >
      {rows.length ? (
        <>
          <LegendList items={series} label={T.periphTitle} />
          <StackedBars label={T.periphTitle} series={series} rows={rows} testId="periph-bars" />
          {pc.categories > rows.length ? <p className="dash-panel__hint">{T.periphMore(F.num(pc.categories - rows.length))}</p> : null}
        </>
      ) : <p className="dash-empty">{T.noCategory}</p>}
      {data.loans ? (
        <p className="dash-inline-stat">
          {T.overdueLoansRow}:{' '}
          <Link href={loansHref(sp, { overdue: 'true' }).href} className={data.loans.overdue > 0 ? 'stat-num stat-num--alert' : 'stat-num'}>{F.num(data.loans.overdue)}</Link>
        </p>
      ) : null}
      {data.lowStock ? (
        <div className="dash-sublist" data-testid="dash-low-stock">
          <h3 className="dash-sublist__title">{T.lowStockTitle}</h3>
          {data.lowStock.length === 0 ? <p className="dash-empty">{T.lowStockEmpty}</p> : (
            <ul>
              {data.lowStock.map((l) => (
                <li key={l.id}>
                  <Link href={lowHref(l)}>{l.target_name}</Link>
                  <span className="dash-sublist__meta">{l.department_name ?? T.companyWide}</span>
                  <span className="stat-num stat-num--alert">{T.lowStockRow(F.num(l.qty), F.num(l.min_qty))}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </ChartPanel>
  );
}

// ───────────────────────── 확인이 필요한 자산 ─────────────────────────

function AttentionPanel({ a, sp, today }: { a: NonNullable<DashboardData['assets']>; sp: URLSearchParams; today: string }) {
  const T = useT(TEXT);
  const F = useFmt();
  const soonTo = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + a.warrantyWindowDays);
    return d.toISOString().slice(0, 10);
  })();
  const lists: { key: string; title: string; total: number; rows: AttentionRow[]; href: string; meta: (r: AttentionRow) => string }[] = [
    { key: 'overdue', title: T.attOverdue, total: a.overdue, rows: a.attention.overdue, href: assetsHref(sp, { overdue: 'true' }), meta: (r) => `${r.holder_name ?? ''} · ${T.attDue(r.due_date ?? '')}` },
    { key: 'warranty', title: T.attWarranty, total: a.warrantySoon, rows: a.attention.warranty, href: assetsHref(addFilter(sp, { warrantyFrom: today, warrantyTo: soonTo, active: 'true' })), meta: (r) => T.attWarrantyEnd(r.warranty_end ?? '') },
    { key: 'missing', title: T.attMissing, total: a.kpi.missing, rows: a.attention.missing, href: assetsHref(addFilter(sp, { state: 'MISSING' })), meta: (r) => r.department_name },
  ];
  return (
    <ChartPanel title={T.attentionTitle} testId="dash-attention">
      <div className="attention-grid">
        {lists.map((l) => (
          <div key={l.key} className="dash-sublist" data-testid={`attention-${l.key}`}>
            <h3 className="dash-sublist__title">
              {l.title} <span className={l.total > 0 ? 'stat-num stat-num--alert' : 'stat-num'}>{F.num(l.total)}</span>
            </h3>
            {l.rows.length === 0 ? <p className="dash-empty">{T.attEmpty}</p> : (
              <>
                <ul>
                  {l.rows.map((r) => (
                    <li key={r.id}>
                      <Link href={`/assets/${r.id}`}>{r.asset_tag}</Link>
                      <span className="dash-sublist__meta" title={`${r.manufacturer} ${r.model_name}`}>{r.model_name}</span>
                      <span className="dash-sublist__meta">{l.meta(r)}</span>
                    </li>
                  ))}
                </ul>
                <p className="dash-sublist__foot">
                  {l.total > l.rows.length ? <span>{T.attMore(F.num(l.total))} · </span> : null}
                  <Link href={l.href}>{T.viewList}</Link>
                </p>
              </>
            )}
          </div>
        ))}
      </div>
    </ChartPanel>
  );
}

// ───────────────────────── 작은 카드(기존) ─────────────────────────

/** 통계 카드(기존 제품의 KPI 카드 모양). tone 은 위쪽 띠의 색이다. */
function Card({ title, testId, tone, children }: { title: string; testId: string; tone: 'blue' | 'green' | 'purple' | 'amber'; children: ReactNode }) {
  return (
    <section aria-label={title} data-testid={testId} className={`stat-card stat-card--${tone}`}>
      <h2 className="stat-card__title">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="stat-rows">{children}</dl>;
}

function Row({
  label, value, alert, href, link, resource,
}: {
  label: string;
  value: string;
  alert?: boolean;
  href?: string;
  link?: (href: string, resource: string, children: ReactNode) => ReactNode;
  resource?: string;
}) {
  const text = <span className={alert ? 'stat-num stat-num--alert' : 'stat-num'}>{value}</span>;
  return (
    <div style={{ display: 'contents' }}>
      <dt>{label}</dt>
      <dd>{href && link && resource ? link(href, resource, text) : text}</dd>
    </div>
  );
}

