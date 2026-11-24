'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useState, type ReactNode } from 'react';
import type { AssetState } from '@/lib/assets/transitions';
import { RequireCompany, useShell } from '../../shell';
import { api, Badge, Button, EmptyRow, ErrorText, PageHeader, smallInput, Table, td } from '../../ui';
import { CreateAssetDialog } from './create-dialog';
import { STATE_SUBSTATES, useAssetLabels } from './labels';
import { isOverdue, listOf, modelLabel, PersonPicker, StateBadge, useDebounced, useList, type PersonRef } from './shared';
import { SORT_KEYS, type AssetPage, type CategoryOption, type DepartmentOption, type ModelOption, type SortKey } from './types';
import { useT } from '../../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../../i18n/format';

const PAGE_SIZE = 50;

/** URL 에서 읽어 API 로 그대로 넘기는 조건. holderName 은 화면 표시용이라 넘기지 않는다. */
const API_KEYS = ['q', 'state', 'substate', 'categoryId', 'modelId', 'departmentId', 'holderPersonId', 'includeVoid', 'overdue', 'sort', 'order', 'page'] as const;

export default function AssetsPage() {
  const T = useT(TEXT);
  return (
    <RequireCompany>
      {/* useSearchParams 는 Suspense 경계 안에서 써야 한다(Next.js 빌드 규칙). */}
      <Suspense fallback={<p style={{ color: '#6b7280' }}>{T.loading}</p>}>
        <AssetsInner />
      </Suspense>
    </RequireCompany>
  );
}

function AssetsInner() {
  const F = useFmt();
  const L = useAssetLabels();
  const T = useT(TEXT);
  const { can, perms } = useShell();
  const router = useRouter();
  const sp = useSearchParams();
  const spKey = sp.toString();
  const get = (k: string) => sp.get(k) ?? '';

  const [data, setData] = useState<AssetPage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; tag: string } | null>(null);
  const [qInput, setQInput] = useState(get('q'));
  const dq = useDebounced(qInput.trim(), 350);

  const categories = useList<CategoryOption>(can('master.category', 'read') ? '/api/master/categories?kind=ASSET&includeInactive=true' : null, 'categories');
  const models = useList<ModelOption>(can('master.model', 'read') ? '/api/master/models?kind=ASSET&includeInactive=true' : null, 'models');
  const departments = useList<DepartmentOption>(can('master.department', 'read') ? '/api/departments' : null, 'departments');
  // 부서 범위가 제한된 사용자에게는 자기 범위의 부서만 고르게 한다(다른 부서는 어차피 결과가 없다).
  const scope = perms.departmentScope;
  const deptOptions = listOf(departments).filter((d) => scope === null || scope.includes(d.id));

  function setParams(patch: Record<string, string | null>, keepPage = false) {
    const next = new URLSearchParams(spKey);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!keepPage) next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `/assets?${qs}` : '/assets', { scroll: false });
  }

  useEffect(() => {
    // 입력이 멈췄을 때만 URL 을 바꾼다.
    if (dq !== (new URLSearchParams(spKey).get('q') ?? '')) setParams({ q: dq || null });
  }, [dq]);

  const [reload, setReload] = useState(0);
  useEffect(() => {
    const from = new URLSearchParams(spKey);
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    for (const k of API_KEYS) {
      const v = from.get(k);
      if (v) params.set(k, v);
    }
    let live = true;
    void (async () => {
      const r = await api<AssetPage>('GET', `/api/assets?${params.toString()}`);
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
  // 제한 필드는 권한이 없으면 서버가 키 자체를 뺀다. 응답에 키가 있을 때만 열을 그린다.
  const showPrice = items.some((r) => 'purchase_price' in r);
  const showSupplier = items.some((r) => 'supplier' in r);
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const page = data?.page ?? 1;

  const sort = (SORT_KEYS as readonly string[]).includes(get('sort')) ? (get('sort') as SortKey) : 'asset_tag';
  const order = get('order') === 'desc' ? 'desc' : 'asc';
  const sortHead = (key: SortKey, label: string): ReactNode => {
    const active = sort === key;
    return (
      <button
        type="button"
        onClick={() => setParams({ sort: key, order: active && order === 'asc' ? 'desc' : 'asc' })}
        aria-label={active ? `${label} (${order === 'asc' ? T.sortAsc : T.sortDesc})` : label}
        style={{ border: 0, background: 'transparent', font: 'inherit', fontWeight: 600, cursor: 'pointer', padding: 0, color: active ? '#1d4ed8' : 'inherit' }}
      >
        {label}{active ? (order === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    );
  };

  const head: ReactNode[] = [
    sortHead('asset_tag', T.colTag), sortHead('model', T.colModel), T.colCategory, T.colSerial, sortHead('state', T.colState),
    sortHead('holder', T.colHolder), sortHead('department', T.colDept), T.colLocation, sortHead('due_date', T.colDue),
  ];
  if (showPrice) head.push(sortHead('purchase_price', T.colPrice));
  if (showSupplier) head.push(T.colSupplier);

  const stateValue = get('state') ? (get('substate') ? `${get('state')}:${get('substate')}` : get('state')) : '';
  const categoryId = get('categoryId');
  const holder: PersonRef | null = get('holderPersonId') ? { id: get('holderPersonId'), name: get('holderName') || get('holderPersonId') } : null;

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={can('asset.item', 'create') ? <Button variant="primary" onClick={() => { setCreated(null); setCreating(true); }}>{T.add}</Button> : null}
      />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 10, fontSize: 14, flexWrap: 'wrap' }}>
        <FilterBox label={T.filterQ}>
          {(id) => (
            <input id={id} type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={T.filterQPlaceholder} maxLength={100} style={{ ...smallInput, width: 230, margin: 0 }} />
          )}
        </FilterBox>
        <FilterBox label={T.filterState}>
          {(id) => (
            <select
              id={id}
              value={stateValue}
              onChange={(e) => {
                const [state, substate] = e.target.value.split(':');
                setParams({ state: state || null, substate: substate || null });
              }}
              style={{ ...smallInput, width: 'auto', margin: 0 }}
            >
              <option value="">{T.all}</option>
              {(Object.keys(L.state) as AssetState[]).map((s) => [
                <option key={s} value={s}>{L.state[s]}</option>,
                ...STATE_SUBSTATES[s].map((sub) => (
                  <option key={`${s}:${sub}`} value={`${s}:${sub}`}>{`${L.state[s]} · ${L.substate[sub]}`}</option>
                )),
              ])}
            </select>
          )}
        </FilterBox>
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
        {spKey ? (
          <div style={{ paddingBottom: 4 }}>
            <Button small variant="link" onClick={() => { setQInput(''); router.replace('/assets', { scroll: false }); }}>{T.reset}</Button>
          </div>
        ) : null}
      </div>

      {created ? (
        <p role="status" style={{ color: '#166534', fontSize: 14 }}>
          {T.created(created.tag)} <Link href={`/assets/${created.id}`}>{T.openCreated}</Link>
        </p>
      ) : null}
      <ErrorText>{loadError}</ErrorText>
      {data === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <Table caption={T.total(data.total)} head={head}>
            {items.length === 0 ? <EmptyRow colSpan={head.length}>{T.empty}</EmptyRow> : null}
            {items.map((a) => (
              <tr key={a.id}>
                <td style={td}><Link href={`/assets/${a.id}`}>{a.asset_tag}</Link></td>
                <td style={td}>{modelLabel({ manufacturer: a.manufacturer, name: a.model_name })}</td>
                <td style={td}>{a.category_name}</td>
                <td style={td}>{a.serial_number ?? ''}</td>
                <td style={td}><StateBadge state={a.state} substate={a.substate} /></td>
                <td style={td}>
                  {a.holder_name ?? ''}
                  {a.holder_employee_no ? <span style={{ color: '#6b7280', fontSize: 12 }}> {a.holder_employee_no}</span> : null}
                </td>
                <td style={td}>{a.department_name}</td>
                <td style={td}>{a.location ?? ''}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {a.due_date ?? ''}
                  {a.state === 'IN_USE' && isOverdue(a.due_date) ? <> <Badge tone="red">{T.overdue}</Badge></> : null}
                </td>
                {showPrice ? <td style={{ ...td, textAlign: 'right' }}>{F.optNum(a.purchase_price)}</td> : null}
                {showSupplier ? <td style={td}>{a.supplier ?? ''}</td> : null}
              </tr>
            ))}
          </Table>
          <nav aria-label={T.page(page, lastPage)} style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 10, fontSize: 14 }}>
            <Button small disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) }, true)}>{T.prev}</Button>
            <span>{T.page(page, lastPage)}</span>
            <Button small disabled={page >= lastPage} onClick={() => setParams({ page: String(page + 1) }, true)}>{T.next}</Button>
          </nav>
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

function FilterBox({ label, width, children }: { label: string; width?: number; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13, color: '#4b5563', width }}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}
