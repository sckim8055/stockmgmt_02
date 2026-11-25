'use client';
import { Suspense, useEffect, useState } from 'react';
import { RequireCompany, useShell } from '../../shell';
import { api, Badge, Button, ErrorText, PageHeader } from '../../ui';
import { listOf, modelLabel, useList } from '../assets/shared';
import type { CategoryOption, DepartmentOption, ModelOption } from '../assets/types';
import type { ThresholdRow } from '../thresholds/labels';
import { AdjustDialog } from './adjust-dialog';
import { HistoryDialog } from './history-dialog';
import { IssueDialog } from './issue-dialog';
import { ReceiveDialog } from './receive-dialog';
import { FilterBox, filterSelect } from './shared';
import { STOCK_SORT_KEYS, type StockPage, type StockRow } from './types';
import { apiQuery, FILTER_PARAM, ListPager, ListTable, parsePageSize, SearchToolbar, useListUrl, type Column, type FieldOption } from '../list-tools';
import { useT } from '../../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../../i18n/format';

/** 주소에서 읽어 API 로 그대로 넘기는 조건. 열 필터(f_<열>)는 apiQuery 가 따로 옮긴다. */
const API_KEYS = ['q', 'qField', 'categoryId', 'modelId', 'departmentId', 'sort', 'order', 'page'] as const;

type Dialog =
  | { kind: 'receive' }
  | { kind: 'ISSUE' | 'LOAN' | 'ADJUST' | 'DISPOSE' | 'history'; stock: StockRow }
  | null;

export default function PeripheralsPage() {
  const T = useT(TEXT);
  return (
    <RequireCompany>
      {/* useSearchParams 는 Suspense 경계 안에서 써야 한다(Next.js 빌드 규칙). */}
      <Suspense fallback={<p style={{ color: 'var(--text-muted)' }}>{T.loading}</p>}>
        <StockInner />
      </Suspense>
    </RequireCompany>
  );
}

/**
 * 이 재고 행에 걸린 한계 수량(한계 수량 API 가 이미 주는 값). 모델 또는 그 카테고리에 걸린 것 중
 * 기업 전체이거나 이 행의 관리 부서인 것. 한계 수량의 수량은 대상 전체의 합계이므로 행의 보유 수량과 다를 수 있다.
 */
function thresholdsFor(s: StockRow, all: ThresholdRow[]): ThresholdRow[] {
  return all.filter(
    (t) => t.is_active && (t.model_id === s.model_id || t.category_id === s.category_id) && (t.department_id === null || t.department_id === s.department_id),
  );
}

function StockInner() {
  const F = useFmt();
  const T = useT(TEXT);
  const { can, perms } = useShell();
  const { spKey, get, setParams, reset } = useListUrl('/peripherals');

  const [data, setData] = useState<StockPage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reload, setReload] = useState(0);

  const categories = useList<CategoryOption>(can('master.category', 'read') ? '/api/master/categories?kind=PERIPHERAL&includeInactive=true' : null, 'categories');
  const models = useList<ModelOption>(can('master.model', 'read') ? '/api/master/models?kind=PERIPHERAL&includeInactive=true' : null, 'models');
  const departments = useList<DepartmentOption>(can('master.department', 'read') ? '/api/departments' : null, 'departments');
  // 한계 수량 상태는 한계 수량 조회 권한이 있을 때만 보인다(목록을 다시 불러올 때 함께 다시 부른다).
  const canThreshold = can('threshold', 'read');
  const thresholds = useList<ThresholdRow>(canThreshold ? `/api/thresholds?r=${reload}` : null, 'thresholds');
  // 부서 범위가 제한된 사용자에게는 자기 범위의 부서만 고르게 한다(다른 부서는 어차피 결과가 없다).
  const scope = perms.departmentScope;
  const deptOptions = listOf(departments).filter((d) => scope === null || scope.includes(d.id));

  const pageSize = parsePageSize(get('pageSize'));
  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await api<StockPage>('GET', `/api/peripherals?${apiQuery(spKey, API_KEYS, pageSize)}`);
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

  /** 처리가 끝났거나(성공) 서버가 거부했을 때(재고가 그사이 바뀜 등): 메시지를 보여 주고 목록을 다시 불러온다. */
  const finish = (tone: 'ok' | 'error', text: string) => {
    setDialog(null);
    setNotice({ tone, text });
    setReload((n) => n + 1);
  };

  const canIssue = can('peripheral.issue', 'execute');
  const canAdjust = can('peripheral.adjust', 'execute');
  const canHistory = can('history.stock', 'read');
  const hasActions = canIssue || canAdjust || canHistory;
  // 작업 열의 기본 너비: 보이는 단추 수에 맞춘다(영어 문구 기준, 단추 하나 약 66px + 칸 여백).
  const actionsWidth = 24 + (canIssue ? 2 * 66 : 0) + (canAdjust ? 2 * 70 : 0) + (canHistory ? 64 : 0);
  const categoryId = get('categoryId');
  const items = data?.items ?? [];
  const sort = (STOCK_SORT_KEYS as readonly string[]).includes(get('sort')) ? get('sort') : 'category';
  const order = get('order') === 'desc' ? 'desc' : 'asc';
  const thresholdList = listOf(thresholds);

  const searchFields: FieldOption[] = [
    { value: 'category', label: T.colCategory },
    { value: 'manufacturer', label: T.colManufacturer },
    { value: 'model', label: T.colModelName },
    { value: 'department', label: T.colDept },
  ];

  const columns: Column<StockRow>[] = [
    { id: 'category', label: T.colCategory, required: true, sort: 'category', filter: 'category', sticky: true, width: 140, cell: (s) => s.category_name },
    { id: 'manufacturer', label: T.colManufacturer, required: true, sort: 'manufacturer', filter: 'manufacturer', width: 130, cell: (s) => s.manufacturer },
    {
      id: 'model', label: T.colModelName, required: true, sort: 'model', filter: 'model', width: 220,
      title: (s) => (s.model_active ? s.model_name : `${s.model_name} ${T.inactive}`),
      cell: (s) => (
        <>
          {s.model_name}
          {s.model_active ? null : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> {T.inactive}</span>}
        </>
      ),
    },
    { id: 'department', label: T.colDept, required: false, sort: 'department', filter: 'department', width: 130, cell: (s) => s.department_name },
    {
      id: 'on_hand', label: T.colOnHand, required: true, sort: 'on_hand', align: 'right', width: 100,
      title: (s) => F.num(s.on_hand_qty),
      cell: (s) => <span className={s.on_hand_qty === 0 ? 'qty qty--zero' : 'qty'}>{F.num(s.on_hand_qty)}</span>,
    },
    { id: 'on_loan', label: T.colOnLoan, required: false, sort: 'on_loan', align: 'right', width: 100, title: (s) => F.num(s.on_loan_qty), cell: (s) => <span className="qty">{F.num(s.on_loan_qty)}</span> },
  ];
  if (canThreshold) {
    columns.push({
      id: 'threshold', label: T.colThreshold, required: false, width: 210,
      // 칸 안의 요소가 한계 수량마다의 설명을 title 로 갖는다.
      title: () => undefined,
      cell: (s) => {
        const ts = thresholdsFor(s, thresholdList);
        if (ts.length === 0) return <span style={{ color: 'var(--text-muted)' }}>{T.thresholdNone}</span>;
        const low = ts.filter((t) => t.state === 'LOW');
        const shown = low[0] ?? ts[0]!;
        return (
          <span title={ts.map((t) => T.thresholdDetail(t.target_name, t.department_name, t.qty, t.min_qty)).join('\n')}>
            <Badge tone={low.length ? 'red' : 'green'}>{low.length ? T.thresholdLow : T.thresholdOk}</Badge>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}> {T.thresholdQty(shown.qty, shown.min_qty)}</span>
          </span>
        );
      },
    });
  }
  columns.push({ id: 'updated_at', label: T.colUpdated, required: false, sort: 'updated_at', width: 170, title: (s) => F.dateTime(s.updated_at), cell: (s) => <time dateTime={s.updated_at}>{F.dateTime(s.updated_at)}</time> });
  if (hasActions) {
    columns.push({
      id: 'actions', label: T.colActions, width: actionsWidth,
      title: () => undefined,
      cell: (s) => (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap' }}>
          {canIssue ? (
            <>
              <Button small disabled={s.on_hand_qty < 1} onClick={() => { setNotice(null); setDialog({ kind: 'ISSUE', stock: s }); }}>{T.issue}</Button>
              <Button small disabled={s.on_hand_qty < 1} onClick={() => { setNotice(null); setDialog({ kind: 'LOAN', stock: s }); }}>{T.loan}</Button>
            </>
          ) : null}
          {canAdjust ? (
            <>
              <Button small onClick={() => { setNotice(null); setDialog({ kind: 'ADJUST', stock: s }); }}>{T.adjust}</Button>
              <Button small variant="danger" disabled={s.on_hand_qty < 1} onClick={() => { setNotice(null); setDialog({ kind: 'DISPOSE', stock: s }); }}>{T.dispose}</Button>
            </>
          ) : null}
          {canHistory ? <Button small variant="link" onClick={() => setDialog({ kind: 'history', stock: s })}>{T.history}</Button> : null}
        </div>
      ),
    });
  }

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={can('peripheral.receive', 'execute') ? <Button variant="primary" onClick={() => { setNotice(null); setDialog({ kind: 'receive' }); }}>{T.receive}</Button> : null}
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
              <select id={id} value={categoryId} onChange={(e) => setParams({ categoryId: e.target.value || null, modelId: null })} style={filterSelect}>
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
              <select id={id} value={get('modelId')} onChange={(e) => setParams({ modelId: e.target.value || null })} style={filterSelect}>
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
              <select id={id} value={get('departmentId')} onChange={(e) => setParams({ departmentId: e.target.value || null })} style={filterSelect}>
                <option value="">{T.all}</option>
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ` ${T.inactive}`}</option>
                ))}
              </select>
            )}
          </FilterBox>
        ) : null}
      </div>

      {notice?.tone === 'ok' ? <p role="status" style={{ color: 'var(--success-text)', fontSize: 14 }}>{notice.text}</p> : null}
      <ErrorText>{notice?.tone === 'error' ? notice.text : loadError}</ErrorText>
      {data === null && !loadError ? <p style={{ color: 'var(--text-muted)' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <ListTable
            testId="stock-table"
            listKey="peripherals"
            caption={T.total(data.total)}
            columns={columns}
            rows={items}
            rowKey={(s) => s.id}
            sort={sort}
            order={order}
            onSort={(key, o) => setParams({ sort: key === 'category' ? null : key, order: o === 'asc' ? null : o })}
            filterValue={(name) => get(`${FILTER_PARAM}${name}`)}
            onFilter={(name, v) => setParams({ [`${FILTER_PARAM}${name}`]: v || null })}
            empty={T.empty}
            footer={<ListPager page={data.page} total={data.total} pageSize={data.pageSize} onPage={(p) => setParams({ page: String(p) }, true)} />}
          />
        </>
      ) : null}

      {dialog?.kind === 'receive' ? (
        <ReceiveDialog models={models} departments={departments} onClose={() => setDialog(null)} onDone={(text) => finish('ok', text)} />
      ) : null}
      {dialog?.kind === 'ISSUE' || dialog?.kind === 'LOAN' ? (
        <IssueDialog
          stock={dialog.stock}
          action={dialog.kind}
          onClose={() => setDialog(null)}
          onDone={(text) => finish('ok', text)}
          onConflict={(text) => finish('error', text)}
        />
      ) : null}
      {dialog?.kind === 'ADJUST' || dialog?.kind === 'DISPOSE' ? (
        <AdjustDialog
          stock={dialog.stock}
          action={dialog.kind}
          onClose={() => setDialog(null)}
          onDone={(text) => finish('ok', text)}
          onConflict={(text) => finish('error', text)}
        />
      ) : null}
      {dialog?.kind === 'history' ? <HistoryDialog stock={dialog.stock} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
