'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { RequireCompany, useShell } from '../../shell';
import { api, Button, EmptyRow, ErrorText, PageHeader, smallInput, Table, td } from '../../ui';
import { listOf, modelLabel, useDebounced, useList } from '../assets/shared';
import type { CategoryOption, DepartmentOption, ModelOption } from '../assets/types';
import { AdjustDialog } from './adjust-dialog';
import { HistoryDialog } from './history-dialog';
import { IssueDialog } from './issue-dialog';
import { ReceiveDialog } from './receive-dialog';
import { FilterBox, filterSelect, Pager } from './shared';
import type { StockPage, StockRow } from './types';
import { useT } from '../../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../../i18n/format';

const PAGE_SIZE = 50;

/** URL 에서 읽어 API 로 그대로 넘기는 조건 */
const API_KEYS = ['q', 'categoryId', 'modelId', 'departmentId', 'page'] as const;

type Dialog =
  | { kind: 'receive' }
  | { kind: 'ISSUE' | 'LOAN' | 'ADJUST' | 'DISPOSE' | 'history'; stock: StockRow }
  | null;

export default function PeripheralsPage() {
  const T = useT(TEXT);
  return (
    <RequireCompany>
      {/* useSearchParams 는 Suspense 경계 안에서 써야 한다(Next.js 빌드 규칙). */}
      <Suspense fallback={<p style={{ color: '#6b7280' }}>{T.loading}</p>}>
        <StockInner />
      </Suspense>
    </RequireCompany>
  );
}

function StockInner() {
  const F = useFmt();
  const T = useT(TEXT);
  const { can, perms } = useShell();
  const router = useRouter();
  const sp = useSearchParams();
  const spKey = sp.toString();
  const get = (k: string) => sp.get(k) ?? '';

  const [data, setData] = useState<StockPage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reload, setReload] = useState(0);
  const [qInput, setQInput] = useState(get('q'));
  const dq = useDebounced(qInput.trim(), 350);

  const categories = useList<CategoryOption>(can('master.category', 'read') ? '/api/master/categories?kind=PERIPHERAL&includeInactive=true' : null, 'categories');
  const models = useList<ModelOption>(can('master.model', 'read') ? '/api/master/models?kind=PERIPHERAL&includeInactive=true' : null, 'models');
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
    router.replace(qs ? `/peripherals?${qs}` : '/peripherals', { scroll: false });
  }

  useEffect(() => {
    // 입력이 멈췄을 때만 URL 을 바꾼다.
    if (dq !== (new URLSearchParams(spKey).get('q') ?? '')) setParams({ q: dq || null });
  }, [dq]);

  useEffect(() => {
    const from = new URLSearchParams(spKey);
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    for (const k of API_KEYS) {
      const v = from.get(k);
      if (v) params.set(k, v);
    }
    let live = true;
    void (async () => {
      const r = await api<StockPage>('GET', `/api/peripherals?${params.toString()}`);
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
  const head = [T.colCategory, T.colModel, T.colDept, T.colOnHand, T.colOnLoan, T.colUpdated, ...(hasActions ? [T.colActions] : [])];
  const categoryId = get('categoryId');
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={can('peripheral.receive', 'execute') ? <Button variant="primary" onClick={() => { setNotice(null); setDialog({ kind: 'receive' }); }}>{T.receive}</Button> : null}
      />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 10, fontSize: 14, flexWrap: 'wrap' }}>
        <FilterBox label={T.filterQ}>
          {(id) => (
            <input id={id} type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={T.filterQPlaceholder} maxLength={100} style={{ ...smallInput, width: 230, margin: 0 }} />
          )}
        </FilterBox>
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
        {spKey ? (
          <div style={{ paddingBottom: 4 }}>
            <Button small variant="link" onClick={() => { setQInput(''); router.replace('/peripherals', { scroll: false }); }}>{T.reset}</Button>
          </div>
        ) : null}
      </div>

      {notice?.tone === 'ok' ? <p role="status" style={{ color: '#166534', fontSize: 14 }}>{notice.text}</p> : null}
      <ErrorText>{notice?.tone === 'error' ? notice.text : loadError}</ErrorText>
      {data === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <Table caption={T.total(data.total)} head={head}>
            {items.length === 0 ? <EmptyRow colSpan={head.length}>{T.empty}</EmptyRow> : null}
            {items.map((s) => (
              <tr key={s.id}>
                <td style={td}>{s.category_name}</td>
                <td style={td}>
                  {modelLabel({ manufacturer: s.manufacturer, name: s.model_name })}
                  {s.model_active ? null : <span style={{ color: '#6b7280', fontSize: 12 }}> {T.inactive}</span>}
                </td>
                <td style={td}>{s.department_name}</td>
                <td style={{ ...td, textAlign: 'right' }}>{F.num(s.on_hand_qty)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{F.num(s.on_loan_qty)}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}><time dateTime={s.updated_at}>{F.dateTime(s.updated_at)}</time></td>
                {hasActions ? (
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
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
                  </td>
                ) : null}
              </tr>
            ))}
          </Table>
          <Pager page={data.page} total={data.total} pageSize={data.pageSize} onPage={(p) => setParams({ page: String(p) }, true)} />
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
