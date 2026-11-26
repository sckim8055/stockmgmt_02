'use client';
import Link from 'next/link';
import { Suspense, useEffect, useId, useState, type ReactNode } from 'react';
import type { AssetState } from '@/lib/assets/transitions';
import { RequireCompany, useShell } from '../../shell';
import { api, Badge, Button, ErrorText, PageHeader, smallInput } from '../../ui';
import { CreateAssetDialog } from './create-dialog';
import { STATE_SUBSTATES, STATE_TONE, stateText, useAssetLabels, type Substate } from './labels';
import { isOverdue, listOf, modelLabel, PersonPicker, StateBadge, useCustomDisplay, useList, type PersonRef } from './shared';
import { SORT_KEYS, type AssetPage, type AssetRow, type CategoryOption, type DepartmentOption, type ModelOption, type SortKey } from './types';
import { apiQuery, FILTER_PARAM, ListPager, ListTable, parsePageSize, SearchToolbar, useListUrl, type Column, type FieldOption } from '../list-tools';
import { useT } from '../../i18n';
import { TEXT } from './page.text';
import { TEXT as DASH_TEXT } from '../page.text';
import { useFmt } from '../../i18n/format';

/**
 * 주소에서 읽어 API 로 그대로 넘기는 조건. holderName 은 화면 표시용이라 넘기지 않는다.
 * 열 필터(f_<열>)는 apiQuery 가 따로 옮긴다.
 */
const API_KEYS = [
  'q', 'qField', 'state', 'substate', 'categoryId', 'modelId', 'departmentId', 'holderPersonId', 'includeVoid', 'overdue', 'sort', 'order', 'page',
  // 대시보드의 "목록 보기"가 옮겨 오는 정확히 같은 값 조건(eq_* 는 apiQuery 가 앞붙이로 옮긴다)
  'active', 'hasHolder', 'purchaseFrom', 'purchaseTo', 'noPurchaseDate', 'warrantyFrom', 'warrantyTo', 'noWarrantyEnd', 'blank',
] as const;
const EXACT_PREFIX = 'eq_';

/** 상태 칩의 순서. 등록 취소(VOID)는 "등록 취소 포함"을 켰을 때만 보인다. */
const CHIP_STATES: AssetState[] = ['IN_STOCK', 'IN_USE', 'MAINTENANCE', 'MISSING', 'ON_ORDER', 'RETIRED', 'VOID'];

export default function AssetsPage() {
  const T = useT(TEXT);
  return (
    <RequireCompany>
      {/* useSearchParams 는 Suspense 경계 안에서 써야 한다(Next.js 빌드 규칙). */}
      <Suspense fallback={<p style={{ color: 'var(--text-muted)' }}>{T.loading}</p>}>
        <AssetsInner />
      </Suspense>
    </RequireCompany>
  );
}

function AssetsInner() {
  const F = useFmt();
  const L = useAssetLabels();
  const T = useT(TEXT);
  const showCustom = useCustomDisplay();
  const { can, perms } = useShell();
  const { spKey, get, setParams, reset } = useListUrl('/assets');

  const [data, setData] = useState<AssetPage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; tag: string } | null>(null);

  const categories = useList<CategoryOption>(can('master.category', 'read') ? '/api/master/categories?kind=ASSET&includeInactive=true' : null, 'categories');
  const models = useList<ModelOption>(can('master.model', 'read') ? '/api/master/models?kind=ASSET&includeInactive=true' : null, 'models');
  const departments = useList<DepartmentOption>(can('master.department', 'read') ? '/api/departments' : null, 'departments');
  // 부서 범위가 제한된 사용자에게는 자기 범위의 부서만 고르게 한다(다른 부서는 어차피 결과가 없다).
  const scope = perms.departmentScope;
  const deptOptions = listOf(departments).filter((d) => scope === null || scope.includes(d.id));

  const pageSize = parsePageSize(get('pageSize'));
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await api<AssetPage>('GET', `/api/assets?${apiQuery(spKey, API_KEYS, pageSize, [FILTER_PARAM, EXACT_PREFIX])}`);
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setLoadError('');
      } else if (!r.redirected) {
        setData(null);
        setLoadError(r.error.message);
      }
    })();
    return () => {
      live = false;
    };
  }, [spKey, reload]);

  const items = data?.items ?? [];
  const fields = data?.fields;
  const sort = (SORT_KEYS as readonly string[]).includes(get('sort')) ? (get('sort') as SortKey) : 'asset_tag';
  const order = get('order') === 'desc' ? 'desc' : 'asc';
  const stateValue = get('state') ? (get('substate') ? `${get('state')}:${get('substate')}` : get('state')) : '';
  const categoryId = get('categoryId');
  const holder: PersonRef | null = get('holderPersonId') ? { id: get('holderPersonId'), name: get('holderName') || get('holderPersonId') } : null;

  // 검색할 필드: 화면에 보이는 열과 같다. 읽을 수 없는 열은 서버가 fields 에서 뺀다.
  const searchFields: FieldOption[] = [
    { value: 'asset_tag', label: T.colTag },
    { value: 'category', label: T.colCategory },
    { value: 'manufacturer', label: T.colManufacturer },
    { value: 'model', label: T.colModel },
    { value: 'serial', label: T.colSerial },
    { value: 'holder', label: T.colHolderOrNo },
    { value: 'department', label: T.colDept },
    { value: 'location', label: T.colLocation },
    ...(fields?.supplier ? [{ value: 'supplier', label: T.colSupplier }] : []),
    ...(fields?.custom ?? []).map((c) => ({ value: `cf.${c.key}`, label: c.label })),
  ];

  const stateSelect = (
    <select
      aria-label={T.filterState}
      value={stateValue}
      onChange={(e) => {
        const [state, substate] = e.target.value.split(':');
        setParams({ state: state || null, substate: substate || null });
      }}
    >
      <option value="">{T.all}</option>
      {(Object.keys(L.state) as AssetState[]).map((s) => [
        <option key={s} value={s}>{L.state[s]}</option>,
        ...STATE_SUBSTATES[s].map((sub) => (
          <option key={`${s}:${sub}`} value={`${s}:${sub}`}>{`${L.state[s]} · ${L.substate[sub]}`}</option>
        )),
      ])}
    </select>
  );

  // 열: 이름 · 필수(엑셀 업로드의 필수 열과 같다) · 정렬 기준 · 열 필터 이름.
  const columns: Column<AssetRow>[] = [
    { id: 'asset_tag', label: T.colTag, required: true, sort: 'asset_tag', filter: 'asset_tag', sticky: true, width: 130, title: (a) => a.asset_tag, cell: (a) => <Link href={`/assets/${a.id}`}>{a.asset_tag}</Link> },
    { id: 'category', label: T.colCategory, required: true, sort: 'category', filter: 'category', width: 120, cell: (a) => a.category_name },
    { id: 'model', label: T.colModel, required: true, sort: 'model', filter: 'model', width: 200, cell: (a) => a.model_name },
    { id: 'state', label: T.colState, required: true, sort: 'state', filterNode: stateSelect, width: 170, title: (a) => stateText(L, a.state, a.substate), cell: (a) => <StateBadge state={a.state} substate={a.substate} /> },
    { id: 'manufacturer', label: T.colManufacturer, required: true, sort: 'manufacturer', filter: 'manufacturer', width: 120, cell: (a) => a.manufacturer },
    { id: 'serial', label: T.colSerial, required: false, sort: 'serial', filter: 'serial', width: 150, cell: (a) => a.serial_number ?? '' },
    { id: 'holder', label: T.colHolder, required: false, sort: 'holder', filter: 'holder', width: 140, cell: (a) => a.holder_name ?? '' },
    { id: 'employee_no', label: T.colEmployeeNo, required: false, sort: 'employee_no', filter: 'employee_no', width: 110, cell: (a) => a.holder_employee_no ?? '' },
    { id: 'department', label: T.colDept, required: false, sort: 'department', filter: 'department', width: 120, cell: (a) => a.department_name },
    { id: 'location', label: T.colLocation, required: false, sort: 'location', filter: 'location', width: 160, cell: (a) => a.location ?? '' },
    { id: 'purchase_date', label: T.colPurchaseDate, required: false, sort: 'purchase_date', filter: 'purchase_date', width: 115, cell: (a) => a.purchase_date ?? '' },
    { id: 'warranty_end', label: T.colWarrantyEnd, required: false, sort: 'warranty_end', filter: 'warranty_end', width: 115, cell: (a) => a.warranty_end ?? '' },
    {
      id: 'due_date', label: T.colDue, required: false, sort: 'due_date', width: 115,
      title: (a) => (a.due_date ? (a.state === 'IN_USE' && isOverdue(a.due_date) ? `${a.due_date} ${T.overdue}` : a.due_date) : ''),
      cell: (a) => (
        <>
          {a.due_date ?? ''}
          {a.state === 'IN_USE' && isOverdue(a.due_date) ? <> <Badge tone="red">{T.overdue}</Badge></> : null}
        </>
      ),
    },
  ];
  if (fields?.supplier) columns.push({ id: 'supplier', label: T.colSupplier, required: false, sort: 'supplier', filter: 'supplier', width: 150, cell: (a) => a.supplier ?? '' });
  if (fields?.purchasePrice) {
    columns.push({ id: 'purchase_price', label: T.colPrice, required: false, sort: 'purchase_price', filter: 'purchase_price', align: 'right', width: 110, cell: (a) => F.optNum(a.purchase_price) });
  }
  for (const c of fields?.custom ?? []) {
    columns.push({
      id: `cf.${c.key}`, label: c.label, required: false, filter: `cf.${c.key}`, width: 150,
      cell: (a) => (a.custom[c.key] === undefined || a.custom[c.key] === null ? '' : showCustom(a.custom[c.key])),
    });
  }

  const summary = data?.summary;
  const chip = (key: string, label: string, n: number, pressed: boolean, onClick: () => void, tone?: string, sub = false): ReactNode => (
    <li key={key}>
      <button type="button" className={sub ? 'status-chip status-chip--sub' : 'status-chip'} aria-pressed={pressed} onClick={onClick} data-testid={`chip-${key}`}>
        {tone ? <span className={`status-chip__dot status-chip__dot--${tone}`} aria-hidden="true" /> : null}
        {label}
        <span className="status-chip__n">{F.num(n)}</span>
      </button>
    </li>
  );

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={can('asset.item', 'create') ? <Button variant="primary" onClick={() => { setCreated(null); setCreating(true); }}>{T.add}</Button> : null}
      />

      <SearchToolbar
        fields={searchFields}
        field={get('qField') || 'all'}
        q={get('q')}
        onSearch={(field, q) => setParams({ q: q || null, qField: field === 'all' ? null : field })}
        onReset={reset}
        pageSize={pageSize}
        onPageSize={(n) => setParams({ pageSize: n === 50 ? null : String(n) })}
        total={data ? data.total : null}
      />

      <div className="list-filters">
        {listOf(categories).length > 0 ? (
          <FilterBox label={T.filterCategory}>
            {(id) => (
              <select id={id} value={categoryId} onChange={(e) => setParams({ categoryId: e.target.value || null, modelId: null })} style={{ ...smallInput, width: 'auto', margin: 0 }}>
                <option value="">{T.all}</option>
                {listOf(categories).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.is_active ? '' : ` ${T.inactive}`}</option>
                ))}
              </select>
            )}
          </FilterBox>
        ) : null}
        {listOf(models).length > 0 ? (
          <FilterBox label={T.filterModel}>
            {(id) => (
              <select id={id} value={get('modelId')} onChange={(e) => setParams({ modelId: e.target.value || null })} style={{ ...smallInput, width: 'auto', maxWidth: 240, margin: 0 }}>
                <option value="">{T.all}</option>
                {listOf(models).filter((m) => !categoryId || m.category_id === categoryId).map((m) => (
                  <option key={m.id} value={m.id}>{modelLabel(m)}{m.is_active ? '' : ` ${T.inactive}`}</option>
                ))}
              </select>
            )}
          </FilterBox>
        ) : null}
        {deptOptions.length > 0 ? (
          <FilterBox label={T.filterDept}>
            {(id) => (
              <select id={id} value={get('departmentId')} onChange={(e) => setParams({ departmentId: e.target.value || null })} style={{ ...smallInput, width: 'auto', margin: 0 }}>
                <option value="">{T.all}</option>
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ` ${T.inactive}`}</option>
                ))}
              </select>
            )}
          </FilterBox>
        ) : null}
        {can('master.person', 'read') ? (
          <FilterBox label={T.filterHolder} width={220}>
            {(id) => (
              <PersonPicker id={id} value={holder} onChange={(p) => setParams({ holderPersonId: p?.id ?? null, holderName: p?.name ?? null })} />
            )}
          </FilterBox>
        ) : null}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 8 }}>
          <input type="checkbox" checked={get('includeVoid') === 'true'} onChange={(e) => setParams({ includeVoid: e.target.checked ? 'true' : null })} />
          {T.includeVoid}
        </label>
        <label title={T.overdueOnlyHint} style={{ display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 8 }}>
          <input type="checkbox" checked={get('overdue') === 'true'} onChange={(e) => setParams({ overdue: e.target.checked ? 'true' : null })} />
          {T.overdueOnly}
        </label>
      </div>

      <ExactChips spKey={spKey} setParams={setParams} fields={fields} />

      {summary ? (
        <ul className="chip-row" aria-label={T.chipsLabel} data-testid="status-chips">
          {chip('all', T.all, summary.total, !get('state'), () => setParams({ state: null, substate: null }))}
          {CHIP_STATES.filter((s) => s !== 'VOID' || get('includeVoid') === 'true').map((s) => {
            const n = summary.byState[s] ?? 0;
            const items: ReactNode[] = [chip(s, L.state[s], n, get('state') === s && !get('substate'), () => setParams({ state: s, substate: null }), STATE_TONE[s])];
            // 재고는 세부 상태(사용 가능·예약·불량)까지 보여 준다.
            if (s === 'IN_STOCK') {
              for (const sub of STATE_SUBSTATES.IN_STOCK) {
                const m = summary.inStock[sub as Substate] ?? 0;
                items.push(chip(`IN_STOCK-${sub}`, `${L.state.IN_STOCK} · ${L.substate[sub]}`, m, get('state') === 'IN_STOCK' && get('substate') === sub, () => setParams({ state: 'IN_STOCK', substate: sub }), undefined, true));
              }
            }
            return items;
          })}
        </ul>
      ) : null}

      {created ? (
        <p role="status" style={{ color: 'var(--success-text)', fontSize: 14 }}>
          {T.created(created.tag)} <Link href={`/assets/${created.id}`}>{T.openCreated}</Link>
        </p>
      ) : null}
      <ErrorText>{loadError}</ErrorText>
      {data === null && !loadError ? <p style={{ color: 'var(--text-muted)' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <ListTable
            testId="assets-table"
            listKey="assets"
            caption={T.total(data.total)}
            columns={columns}
            rows={items}
            rowKey={(a) => a.id}
            sort={sort}
            order={order}
            onSort={(key, o) => setParams({ sort: key === 'asset_tag' ? null : key, order: o === 'asc' ? null : o })}
            filterValue={(name) => get(`${FILTER_PARAM}${name}`)}
            onFilter={(name, v) => setParams({ [`${FILTER_PARAM}${name}`]: v || null })}
            empty={T.empty}
            footer={<ListPager page={data.page} total={data.total} pageSize={data.pageSize} onPage={(p) => setParams({ page: String(p) }, true)} />}
          />
        </>
      ) : null}

      {creating ? (
        <CreateAssetDialog
          models={models}
          departments={departments}
          onClose={() => setCreating(false)}
          onCreated={(id, tag) => {
            setCreating(false);
            setCreated({ id, tag });
            setReload((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 대시보드에서 들어온 "정확히 같은 값" 조건(목록의 다른 칸으로는 보이지 않는 것)을 칩으로 보여 주고 하나씩 지우게 한다.
 * 이 조건이 걸려 있는데 보이지 않으면 목록이 왜 줄었는지 알 수 없기 때문이다.
 */
function ExactChips({ spKey, setParams, fields }: { spKey: string; setParams: (p: Record<string, string | null>) => void; fields: AssetPage['fields'] | undefined }) {
  const D = useT(DASH_TEXT);
  const sp = new URLSearchParams(spKey);
  const label = (key: string) => fields?.custom.find((c) => c.key === key)?.label ?? key;
  const chips: { id: string; text: string; patch: Record<string, string | null> }[] = [];
  const range = (a: string | null, b: string | null) => `${a ?? ''} ~ ${b ?? ''}`;
  for (const [k, v] of sp) {
    if (!v || !k.startsWith(EXACT_PREFIX)) continue;
    const name = k === 'eq_manufacturer' ? D.chip.eq_manufacturer : k === 'eq_location' ? D.chip.eq_location : label(k.slice('eq_cf.'.length));
    chips.push({ id: k, text: `${name}: ${v}`, patch: { [k]: null } });
  }
  const blanks = (sp.get('blank') ?? '').split(',').filter(Boolean);
  for (const b of blanks) {
    const rest = blanks.filter((x) => x !== b).join(',');
    chips.push({ id: `blank-${b}`, text: `${b === 'location' ? D.chip.eq_location : label(b.slice(3))}: ${D.chipBlank}`, patch: { blank: rest || null } });
  }
  if (sp.get('hasHolder')) chips.push({ id: 'hasHolder', text: `${D.chip.hasHolder}: ${sp.get('hasHolder') === 'true' ? D.chipYes : D.chipNo}`, patch: { hasHolder: null } });
  if (sp.get('purchaseFrom') || sp.get('purchaseTo')) chips.push({ id: 'purchase', text: `${D.chip.purchase}: ${range(sp.get('purchaseFrom'), sp.get('purchaseTo'))}`, patch: { purchaseFrom: null, purchaseTo: null } });
  if (sp.get('noPurchaseDate')) chips.push({ id: 'noPurchaseDate', text: `${D.chip.purchase}: ${D.chipNone}`, patch: { noPurchaseDate: null } });
  if (sp.get('warrantyFrom') || sp.get('warrantyTo')) chips.push({ id: 'warranty', text: `${D.chip.warranty}: ${range(sp.get('warrantyFrom'), sp.get('warrantyTo'))}`, patch: { warrantyFrom: null, warrantyTo: null } });
  if (sp.get('noWarrantyEnd')) chips.push({ id: 'noWarrantyEnd', text: `${D.chip.warranty}: ${D.chipNone}`, patch: { noWarrantyEnd: null } });
  if (sp.get('active')) chips.push({ id: 'active', text: D.chipActive, patch: { active: null } });
  if (!chips.length) return null;
  return (
    <div className="dash-chips-row" style={{ marginTop: 0, marginBottom: 10 }}>
      <span className="dash-chips-row__label">{D.activeFilters}</span>
      <ul className="dash-chips" data-testid="exact-chips">
        {chips.map((c) => (
          <li key={c.id}>
            <button type="button" className="filter-chip" onClick={() => setParams(c.patch)} aria-label={D.removeChip(c.text)}>
              {c.text} <span aria-hidden="true" className="filter-chip__x">×</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilterBox({ label, width, children }: { label: string; width?: number; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13, color: 'var(--text-secondary)', width }}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}
