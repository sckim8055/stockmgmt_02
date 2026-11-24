'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import { api, Badge, Button, ConfirmDialog, EmptyRow, ErrorText, LabeledField, Modal, Notice, PageHeader, smallInput, Table, td } from '../../../ui';
import { useT } from '../../../i18n';
import { TEXT } from './page.text';

const PAGE_SIZE = 50;

interface PersonRow {
  id: string;
  employee_no: string | null;
  name: string;
  department_id: string | null;
  department_name: string | null;
  email: string | null;
  is_active: boolean;
  anonymized_at: string | null;
}

interface PersonPage {
  total: number;
  page: number;
  pageSize: number;
  items: PersonRow[];
}

interface DepartmentRow {
  id: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
}

/** 퇴사 거부(409 HOLDS_ITEMS) 응답의 보유 수량. 형식이 다르면 null. */
function readHolding(raw: unknown): { assets: number; openLoans: number } | null {
  if (typeof raw !== 'object' || raw === null || !('holding' in raw)) return null;
  const h = (raw as { holding: unknown }).holding;
  if (typeof h !== 'object' || h === null) return null;
  const assets = (h as { assets?: unknown }).assets;
  const openLoans = (h as { openLoans?: unknown }).openLoans;
  return typeof assets === 'number' && typeof openLoans === 'number' ? { assets, openLoans } : null;
}

type Pending = { kind: 'activate' | 'deactivate' | 'anonymize'; person: PersonRow } | null;

export default function PersonsPage() {
  return (
    <RequireCompany>
      <PersonsInner />
    </RequireCompany>
  );
}

function PersonsInner() {
  const T = useT(TEXT);
  const { can } = useShell();
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PersonPage | null>(null);
  const [loadError, setLoadError] = useState('');
  // null = 불러오는 중, 'denied' = 부서 조회 권한 없음
  const [departments, setDepartments] = useState<DepartmentRow[] | 'denied' | null>(null);
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; person: PersonRow } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (departmentId) params.set('departmentId', departmentId);
    if (includeInactive) params.set('includeInactive', 'true');
    const r = await api<PersonPage>('GET', `/api/master/persons?${params.toString()}`);
    if (r.ok) {
      setData(r.data);
      setLoadError('');
    } else if (!r.redirected) setLoadError(r.error.message);
  }, [q, departmentId, includeInactive, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const r = await api<{ departments: DepartmentRow[] }>('GET', '/api/departments');
      if (r.ok) setDepartments(r.data.departments);
      else if (!r.redirected) setDepartments('denied');
    })();
  }, []);

  const deptList = Array.isArray(departments) ? departments : [];
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  async function runPending(p: NonNullable<Pending>): Promise<string | null> {
    const r = await api<{ ok: true }>('POST', `/api/master/persons/${encodeURIComponent(p.person.id)}/${p.kind}`);
    if (!r.ok) {
      if (r.redirected) return null;
      if (r.error.code === 'HOLDS_ITEMS') {
        const h = readHolding(r.raw);
        if (h) return T.holds(h.assets, h.openLoans);
      }
      return r.error.message;
    }
    setPending(null);
    setNotice(T.saved);
    void load();
    return null;
  }

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={can('master.person', 'create') ? <Button variant="primary" onClick={() => { setNotice(''); setForm({ mode: 'create' }); }}>{T.add}</Button> : null}
      />
      <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 10px' }}>{T.intro}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQ(qInput.trim());
        }}
        style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10, fontSize: 14, flexWrap: 'wrap' }}
      >
        <label>
          {T.filterQ}{' '}
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={T.filterQPlaceholder} maxLength={100} style={{ ...smallInput, width: 200, margin: 0 }} />
        </label>
        <Button type="submit" small>{T.search}</Button>
        {deptList.length > 0 ? (
          <label>
            {T.filterDept}{' '}
            <select value={departmentId} onChange={(e) => { setPage(1); setDepartmentId(e.target.value); }} style={{ ...smallInput, width: 'auto', margin: 0 }}>
              <option value="">{T.all}</option>
              {deptList.map((d) => (
                <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ` ${T.inactiveDept}`}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => { setPage(1); setIncludeInactive(e.target.checked); }} />
          {T.includeInactive}
        </label>
      </form>
      {notice ? <p role="status" style={{ color: '#166534', fontSize: 14 }}>{notice}</p> : null}
      <ErrorText>{loadError}</ErrorText>
      {data === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <Table caption={T.total(data.total)} head={[T.colEmpNo, T.colName, T.colDept, T.colEmail, T.colStatus, T.colActions]}>
            {data.items.length === 0 ? <EmptyRow colSpan={6}>{T.empty}</EmptyRow> : null}
            {data.items.map((p) => (
              <tr key={p.id}>
                <td style={td}>{p.employee_no ?? ''}</td>
                <td style={td}>{p.name}</td>
                <td style={td}>{p.department_name ?? ''}</td>
                <td style={td}>{p.email ?? ''}</td>
                <td style={td}>
                  {p.is_active ? <Badge tone="green">{T.active}</Badge> : <Badge tone="gray">{T.inactive}</Badge>}
                  {p.anonymized_at ? <Badge tone="red">{T.anonymizedBadge}</Badge> : null}
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {p.anonymized_at ? null : (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {can('master.person', 'update') ? (
                        <Button small onClick={() => { setNotice(''); setForm({ mode: 'edit', person: p }); }}>{T.edit}</Button>
                      ) : null}
                      {p.is_active && can('master.person', 'deactivate') ? (
                        <Button small variant="danger" onClick={() => setPending({ kind: 'deactivate', person: p })}>{T.deactivate}</Button>
                      ) : null}
                      {!p.is_active && can('master.person', 'activate') ? (
                        <Button small onClick={() => setPending({ kind: 'activate', person: p })}>{T.activate}</Button>
                      ) : null}
                      {!p.is_active && can('master.person', 'deactivate') ? (
                        <Button small variant="danger" onClick={() => setPending({ kind: 'anonymize', person: p })}>{T.anonymize}</Button>
                      ) : null}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          <nav aria-label={T.page(data.page, lastPage)} style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 10, fontSize: 14 }}>
            <Button small disabled={page <= 1} onClick={() => setPage((x) => Math.max(1, x - 1))}>{T.prev}</Button>
            <span>{T.page(data.page, lastPage)}</span>
            <Button small disabled={page >= lastPage} onClick={() => setPage((x) => x + 1)}>{T.next}</Button>
          </nav>
        </>
      ) : null}

      {form ? (
        <PersonForm
          key={form.mode === 'edit' ? form.person.id : 'new'}
          person={form.mode === 'edit' ? form.person : null}
          departments={departments}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            setNotice(T.saved);
            void load();
          }}
        />
      ) : null}

      {pending && pending.kind !== 'anonymize' ? (
        <ConfirmDialog
          title={pending.kind === 'activate' ? T.confirmActivateTitle : T.confirmDeactivateTitle}
          message={pending.kind === 'activate' ? T.confirmActivate(pending.person.name) : T.confirmDeactivate(pending.person.name)}
          confirmLabel={pending.kind === 'activate' ? T.activate : T.deactivate}
          danger={pending.kind === 'deactivate'}
          onConfirm={() => runPending(pending)}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending && pending.kind === 'anonymize' ? (
        <AnonymizeDialog person={pending.person} onConfirm={() => runPending(pending)} onClose={() => setPending(null)} />
      ) : null}
    </div>
  );
}

/** 되돌릴 수 없는 작업이라 확인 문구를 직접 입력해야 버튼이 켜진다. */
function AnonymizeDialog({ person, onConfirm, onClose }: { person: PersonRow; onConfirm: () => Promise<string | null>; onClose: () => void }) {
  const T = useT(TEXT);
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = typed.trim() === T.anonymizeWord;
  return (
    <Modal
      title={T.anonymizeTitle}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button
            variant="danger"
            disabled={!ready || busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              const err = await onConfirm();
              setBusy(false);
              if (err) setError(err);
            }}
          >
            {busy ? T.processing : T.anonymizeConfirm}
          </Button>
        </>
      }
    >
      <div role="alert" style={{ background: '#fdecec', color: '#991b1b', borderRadius: 6, padding: '10px 12px', fontSize: 14, lineHeight: 1.6 }}>
        <strong>{T.anonymizeWarn1(person.name)}</strong>
        <br />
        {T.anonymizeWarn2}
        <br />
        {T.anonymizeWarn3}
      </div>
      <label htmlFor={inputId} style={{ display: 'block', fontSize: 13, color: '#4b5563', marginTop: 12 }}>{T.anonymizeType(T.anonymizeWord)}</label>
      <input id={inputId} style={smallInput} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

function PersonForm({
  person,
  departments,
  onClose,
  onSaved,
}: {
  person: PersonRow | null;
  departments: DepartmentRow[] | 'denied' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const T = useT(TEXT);
  const [employeeNo, setEmployeeNo] = useState(person?.employee_no ?? '');
  const [name, setName] = useState(person?.name ?? '');
  const [departmentId, setDepartmentId] = useState(person?.department_id ?? '');
  const [email, setEmail] = useState(person?.email ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const deptUsable = Array.isArray(departments);
  // 새로 고를 수 있는 것은 활성 부서뿐이다. 현재 부서는 비활성이어도 남겨 둔다.
  const options = deptUsable ? departments.filter((d) => d.is_active || d.id === person?.department_id) : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const body: Record<string, string | null> = { employeeNo: employeeNo.trim() || null, name: name.trim(), email: email.trim() || null };
    // 부서 목록을 볼 수 없으면 부서는 보내지 않는다(기존 값을 지우지 않기 위해).
    if (deptUsable) body.departmentId = departmentId || null;
    const r = person
      ? await api<{ ok: true }>('PATCH', `/api/master/persons/${encodeURIComponent(person.id)}`, body)
      : await api<{ personId: string }>('POST', '/api/master/persons', body);
    setBusy(false);
    if (r.ok) onSaved();
    else if (!r.redirected) setError(r.error.message);
  }

  return (
    <Modal title={person ? T.formEdit(person.name) : T.formCreate} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <LabeledField label={T.fEmpNo} hint={T.fEmpNoHint}>
          {(id) => <input id={id} style={smallInput} value={employeeNo} onChange={(e) => setEmployeeNo(e.target.value)} maxLength={40} autoComplete="off" />}
        </LabeledField>
        <LabeledField label={T.fName}>
          {(id) => <input id={id} style={smallInput} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="off" />}
        </LabeledField>
        {deptUsable ? (
          <LabeledField label={T.fDept}>
            {(id) => (
              <select id={id} style={smallInput} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">{T.fDeptNone}</option>
                {options.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ` ${T.inactiveDept}`}</option>
                ))}
              </select>
            )}
          </LabeledField>
        ) : departments === 'denied' ? (
          <Notice>{T.fDeptUnavailable}</Notice>
        ) : null}
        <LabeledField label={T.fEmail}>
          {(id) => <input id={id} type="email" style={smallInput} value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} autoComplete="off" />}
        </LabeledField>
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? T.saving : person ? T.save : T.create}</Button>
        </div>
      </form>
    </Modal>
  );
}
