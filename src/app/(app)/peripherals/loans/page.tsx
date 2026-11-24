'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import { api, Badge, Button, EmptyRow, ErrorText, PageHeader, smallInput, Table, td } from '../../../ui';
import { listOf, PersonPicker, useDebounced, useList, type PersonRef } from '../../assets/shared';
import type { DepartmentOption } from '../../assets/types';
import { usePeripheralLabels } from '../labels';
import { FilterBox, filterSelect, Pager } from '../shared';
import type { LoanPage, LoanRow, LoanStatus } from '../types';
import { LoanDialog } from './loan-dialog';
import { useT } from '../../../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../../../i18n/format';

const PAGE_SIZE = 50;

/** URL 에서 읽어 API 로 그대로 넘기는 조건. personName 은 화면 표시용이라 넘기지 않는다. */
const API_KEYS = ['q', 'status', 'overdue', 'departmentId', 'personId', 'page'] as const;
const STATUS_VALUES = ['OPEN', 'CLOSED', 'ALL'] as const;

export default function LoansPage() {
  const T = useT(TEXT);
  return (
    <RequireCompany>
      <Suspense fallback={<p style={{ color: 'var(--text-muted)' }}>{T.loading}</p>}>
        <LoansInner />
      </Suspense>
    </RequireCompany>
  );
}

function LoansInner() {
  const L = usePeripheralLabels();
  const T = useT(TEXT);
  const { can, perms } = useShell();
  const router = useRouter();
  const sp = useSearchParams();
  const spKey = sp.toString();
  const get = (k: string) => sp.get(k) ?? '';

  const [data, setData] = useState<LoanPage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [dialog, setDialog] = useState<{ action: 'RETURN' | 'LOAN_LOSS'; loan: LoanRow } | null>(null);
  const [reload, setReload] = useState(0);
  const [qInput, setQInput] = useState(get('q'));
  const dq = useDebounced(qInput.trim(), 350);

  const departments = useList<DepartmentOption>(can('master.department', 'read') ? '/api/departments' : null, 'departments');
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
    router.replace(qs ? `/peripherals/loans?${qs}` : '/peripherals/loans', { scroll: false });
  }

  useEffect(() => {
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
      const r = await api<LoanPage>('GET', `/api/peripherals/loans?${params.toString()}`);
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

  const finish = (tone: 'ok' | 'error', text: string) => {
    setDialog(null);
    setNotice({ tone, text });
    setReload((n) => n + 1);
  };

  const canAct = can('peripheral.issue', 'execute');
  const status = (STATUS_VALUES as readonly string[]).includes(get('status')) ? get('status') : 'OPEN';
  const showStatus = status !== 'OPEN';
  const head = [
    T.colPerson, T.colModel, T.colDept, T.colQty, T.colOutstanding, T.colLoaned, T.colDue,
    ...(showStatus ? [T.colStatus] : []), ...(canAct ? [T.colActions] : []),
  ];
  const person: PersonRef | null = get('personId') ? { id: get('personId'), name: get('personName') || get('personId') } : null;
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader title={T.title} />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 10, fontSize: 14, flexWrap: 'wrap' }}>
        <FilterBox label={T.filterQ}>
          {(id) => (
            <input id={id} type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={T.filterQPlaceholder} maxLength={100} style={{ ...smallInput, width: 200, margin: 0 }} />
          )}
        </FilterBox>
        <FilterBox label={T.filterStatus}>
          {(id) => (
            <select id={id} value={status} onChange={(e) => setParams({ status: e.target.value === 'OPEN' ? null : e.target.value })} style={filterSelect}>
              {STATUS_VALUES.map((s) => (
                <option key={s} value={s}>{L.loanFilter[s]}</option>
              ))}
            </select>
          )}
        </FilterBox>
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
        {can('master.person', 'read') ? (
          <FilterBox label={T.filterPerson} width={220}>
            {(id) => <PersonPicker id={id} value={person} onChange={(p) => setParams({ personId: p?.id ?? null, personName: p?.name ?? null })} />}
          </FilterBox>
        ) : null}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 8 }}>
          <input type="checkbox" checked={get('overdue') === 'true'} onChange={(e) => setParams({ overdue: e.target.checked ? 'true' : null })} />
          {T.overdueOnly}
        </label>
        {spKey ? (
          <div style={{ paddingBottom: 4 }}>
            <Button small variant="link" onClick={() => { setQInput(''); router.replace('/peripherals/loans', { scroll: false }); }}>{T.reset}</Button>
          </div>
        ) : null}
      </div>

      {notice?.tone === 'ok' ? <p role="status" style={{ color: 'var(--success-text)', fontSize: 14 }}>{notice.text}</p> : null}
      <ErrorText>{notice?.tone === 'error' ? notice.text : loadError}</ErrorText>
      {data === null && !loadError ? <p style={{ color: 'var(--text-muted)' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <Table caption={T.total(data.total)} head={head}>
            {items.length === 0 ? <EmptyRow colSpan={head.length}>{T.empty}</EmptyRow> : null}
            {items.map((l) => (
              <LoanTableRow
                key={l.id}
                loan={l}
                showStatus={showStatus}
                canAct={canAct}
                onAction={(action) => { setNotice(null); setDialog({ action, loan: l }); }}
              />
            ))}
          </Table>
          <Pager page={data.page} total={data.total} pageSize={data.pageSize} onPage={(p) => setParams({ page: String(p) }, true)} />
        </>
      ) : null}

      {dialog ? (
        <LoanDialog
          loan={dialog.loan}
          action={dialog.action}
          onClose={() => setDialog(null)}
          onDone={(text) => finish('ok', text)}
          onConflict={(text) => finish('error', text)}
        />
      ) : null}
    </div>
  );
}

const STATUS_TONE: Record<LoanStatus, 'blue' | 'gray'> = { OPEN: 'blue', CLOSED: 'gray' };

function LoanTableRow({
  loan: l,
  showStatus,
  canAct,
  onAction,
}: {
  loan: LoanRow;
  showStatus: boolean;
  canAct: boolean;
  onAction: (action: 'RETURN' | 'LOAN_LOSS') => void;
}) {
  const F = useFmt();
  const L = usePeripheralLabels();
  const T = useT(TEXT);
  const open = l.status === 'OPEN';
  return (
    <tr style={l.overdue ? { background: 'var(--danger-row-bg)' } : undefined}>
      <td style={td}>
        {l.person_name}
        {l.person_active ? null : <> <Badge tone="gray">{T.personLeft}</Badge></>}
      </td>
      <td style={td}>{l.manufacturer} {l.model_name}</td>
      <td style={td}>{l.department_name}</td>
      <td style={{ ...td, textAlign: 'right' }}>{F.num(l.qty)}</td>
      <td style={{ ...td, textAlign: 'right' }}>
        {F.num(l.outstanding_qty)}
        {l.returned_qty > 0 || l.lost_qty > 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{T.breakdown(l.returned_qty, l.lost_qty)}</div> : null}
      </td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}><time dateTime={l.loaned_at} title={F.dateTime(l.loaned_at)}>{F.date(l.loaned_at)}</time></td>
      <td style={{ ...td, whiteSpace: 'nowrap', color: l.overdue ? 'var(--danger-text)' : undefined, fontWeight: l.overdue ? 600 : undefined }}>
        {l.due_date ?? ''}
        {l.overdue ? <> <Badge tone="red">{T.overdue}</Badge></> : null}
      </td>
      {showStatus ? <td style={td}><Badge tone={STATUS_TONE[l.status]}>{L.loanStatus[l.status]}</Badge></td> : null}
      {canAct ? (
        <td style={{ ...td, whiteSpace: 'nowrap' }}>
          {open ? (
            <div style={{ display: 'flex', gap: 4 }}>
              <Button small onClick={() => onAction('RETURN')}>{T.returnAction}</Button>
              <Button small variant="danger" onClick={() => onAction('LOAN_LOSS')}>{T.lossAction}</Button>
            </div>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}
