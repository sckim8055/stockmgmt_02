'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import { api, Badge, Button, ConfirmDialog, EmptyRow, ErrorText, LabeledField, Modal, Notice, PageHeader, smallInput, Table, td } from '../../../ui';
import { useT } from '../../../i18n';
import { TEXT } from './page.text';

interface DepartmentRow {
  id: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
}

type Pending = { kind: 'activate' | 'deactivate' | 'delete'; dept: DepartmentRow } | null;

export default function DepartmentsPage() {
  return (
    <RequireCompany>
      <DepartmentsInner />
    </RequireCompany>
  );
}

function DepartmentsInner() {
  const T = useT(TEXT);
  const { can, perms } = useShell();
  const [rows, setRows] = useState<DepartmentRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; dept: DepartmentRow } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ departments: DepartmentRow[] }>('GET', '/api/departments');
    if (r.ok) {
      setRows(r.data.departments);
      setLoadError('');
    } else if (!r.redirected) setLoadError(r.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 부서 구조 변경은 부서 범위 제한이 없는 계정만 할 수 있다(서버가 다시 판정한다).
  const scoped = !perms.all && perms.departmentScope !== null;
  const allowed = (op: string) => !scoped && can('master.department', op);

  async function runPending(p: NonNullable<Pending>): Promise<string | null> {
    const base = `/api/departments/${encodeURIComponent(p.dept.id)}`;
    const r = p.kind === 'delete' ? await api<{ ok: true }>('DELETE', base) : await api<{ ok: true }>('POST', `${base}/${p.kind}`);
    if (!r.ok) return r.redirected ? null : r.error.message;
    setPending(null);
    setNotice(T.saved);
    void load();
    return null;
  }

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={allowed('create') ? <Button variant="primary" onClick={() => { setNotice(''); setForm({ mode: 'create' }); }}>{T.add}</Button> : null}
      />
      {scoped ? <Notice>{T.scopedNote}</Notice> : null}
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 10px' }}>{T.defaultNote}</p>
      {notice ? <p role="status" style={{ color: 'var(--success-text)', fontSize: 14 }}>{notice}</p> : null}
      <ErrorText>{loadError}</ErrorText>
      {rows === null && !loadError ? <p style={{ color: 'var(--text-muted)' }}>{T.loading}</p> : null}
      {rows ? (
        <Table head={[T.colName, T.colStatus, T.colActions]}>
          {rows.length === 0 ? <EmptyRow colSpan={3}>{T.empty}</EmptyRow> : null}
          {rows.map((d) => (
            <tr key={d.id}>
              <td style={td}>
                {d.name} {d.is_default ? <Badge tone="blue">{T.defaultBadge}</Badge> : null}
              </td>
              <td style={td}>{d.is_active ? <Badge tone="green">{T.active}</Badge> : <Badge tone="gray">{T.inactive}</Badge>}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {allowed('update') ? (
                    <Button small onClick={() => { setNotice(''); setForm({ mode: 'edit', dept: d }); }}>{T.edit}</Button>
                  ) : null}
                  {d.is_active && !d.is_default && allowed('deactivate') ? (
                    <Button small variant="danger" onClick={() => setPending({ kind: 'deactivate', dept: d })}>{T.deactivate}</Button>
                  ) : null}
                  {!d.is_active && allowed('activate') ? (
                    <Button small onClick={() => setPending({ kind: 'activate', dept: d })}>{T.activate}</Button>
                  ) : null}
                  {!d.is_default && allowed('delete') ? (
                    <Button small variant="danger" onClick={() => setPending({ kind: 'delete', dept: d })}>{T.remove}</Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}

      {form ? (
        <DepartmentForm
          key={form.mode === 'edit' ? form.dept.id : 'new'}
          dept={form.mode === 'edit' ? form.dept : null}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            setNotice(T.saved);
            void load();
          }}
        />
      ) : null}

      {pending ? (
        <ConfirmDialog
          title={pending.kind === 'activate' ? T.confirmActivateTitle : pending.kind === 'deactivate' ? T.confirmDeactivateTitle : T.confirmDeleteTitle}
          message={
            pending.kind === 'activate' ? T.confirmActivate(pending.dept.name)
              : pending.kind === 'deactivate' ? T.confirmDeactivate(pending.dept.name)
                : T.confirmDelete(pending.dept.name)
          }
          confirmLabel={pending.kind === 'activate' ? T.activate : pending.kind === 'deactivate' ? T.deactivate : T.remove}
          danger={pending.kind !== 'activate'}
          onConfirm={() => runPending(pending)}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

function DepartmentForm({ dept, onClose, onSaved }: { dept: DepartmentRow | null; onClose: () => void; onSaved: () => void }) {
  const T = useT(TEXT);
  const [name, setName] = useState(dept?.name ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const body = { name: name.trim() };
    const r = dept
      ? await api<{ ok: true }>('PATCH', `/api/departments/${encodeURIComponent(dept.id)}`, body)
      : await api<{ departmentId: string }>('POST', '/api/departments', body);
    setBusy(false);
    if (r.ok) onSaved();
    else if (!r.redirected) setError(r.error.message);
  }

  return (
    <Modal title={dept ? T.formEdit(dept.name) : T.formCreate} onClose={onClose} width={420}>
      <form onSubmit={submit}>
        <LabeledField label={T.fName}>
          {(id) => <input id={id} style={smallInput} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />}
        </LabeledField>
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? T.saving : dept ? T.save : T.create}</Button>
        </div>
      </form>
    </Modal>
  );
}
