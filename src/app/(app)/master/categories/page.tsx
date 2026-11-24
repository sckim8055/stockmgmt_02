'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import { api, Badge, Button, ConfirmDialog, EmptyRow, ErrorText, LabeledField, Modal, PageHeader, smallInput, Table, td } from '../../../ui';
import { useT } from '../../../i18n';
import { TEXT } from './page.text';

type Kind = 'ASSET' | 'PERIPHERAL';

interface CategoryRow {
  id: string;
  kind: Kind;
  name: string;
  name_ko: string | null;
  name_zh: string | null;
  sort_order: number;
  is_active: boolean;
  model_count: number;
}

type Pending = { kind: 'activate' | 'deactivate' | 'delete'; cat: CategoryRow } | null;

export default function CategoriesPage() {
  return (
    <RequireCompany>
      <CategoriesInner />
    </RequireCompany>
  );
}

function CategoriesInner() {
  const T = useT(TEXT);
  const { can } = useShell();
  const [kind, setKind] = useState<Kind | ''>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [rows, setRows] = useState<CategoryRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; cat: CategoryRow } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (includeInactive) params.set('includeInactive', 'true');
    const r = await api<{ categories: CategoryRow[] }>('GET', `/api/master/categories?${params.toString()}`);
    if (r.ok) {
      setRows(r.data.categories);
      setLoadError('');
    } else if (!r.redirected) setLoadError(r.error.message);
  }, [kind, includeInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runPending(p: NonNullable<Pending>): Promise<string | null> {
    const base = `/api/master/categories/${encodeURIComponent(p.cat.id)}`;
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
        actions={can('master.category', 'create') ? <Button variant="primary" onClick={() => { setNotice(''); setForm({ mode: 'create' }); }}>{T.add}</Button> : null}
      />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 10, fontSize: 14 }}>
        <label>
          {T.filterKind}{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind | '')} style={{ ...smallInput, width: 'auto', margin: 0 }}>
            <option value="">{T.kindAll}</option>
            <option value="ASSET">{T.kind.ASSET}</option>
            <option value="PERIPHERAL">{T.kind.PERIPHERAL}</option>
          </select>
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          {T.includeInactive}
        </label>
      </div>
      {notice ? <p role="status" style={{ color: '#166534', fontSize: 14 }}>{notice}</p> : null}
      <ErrorText>{loadError}</ErrorText>
      {rows === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {rows ? (
        <Table head={[T.colName, T.colKind, T.colNameKo, T.colNameZh, T.colSort, T.colModels, T.colStatus, T.colActions]}>
          {rows.length === 0 ? <EmptyRow colSpan={8}>{T.empty}</EmptyRow> : null}
          {rows.map((c) => (
            <tr key={c.id}>
              <td style={td}>{c.name}</td>
              <td style={td}><Badge tone={c.kind === 'ASSET' ? 'blue' : 'amber'}>{T.kind[c.kind]}</Badge></td>
              <td style={td}>{c.name_ko ?? ''}</td>
              <td style={td}>{c.name_zh ?? ''}</td>
              <td style={{ ...td, textAlign: 'right' }}>{c.sort_order}</td>
              <td style={{ ...td, textAlign: 'right' }}>{c.model_count}</td>
              <td style={td}>{c.is_active ? <Badge tone="green">{T.active}</Badge> : <Badge tone="gray">{T.inactive}</Badge>}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {can('master.category', 'update') ? (
                    <Button small onClick={() => { setNotice(''); setForm({ mode: 'edit', cat: c }); }}>{T.edit}</Button>
                  ) : null}
                  {c.is_active && can('master.category', 'deactivate') ? (
                    <Button small variant="danger" onClick={() => setPending({ kind: 'deactivate', cat: c })}>{T.deactivate}</Button>
                  ) : null}
                  {!c.is_active && can('master.category', 'activate') ? (
                    <Button small onClick={() => setPending({ kind: 'activate', cat: c })}>{T.activate}</Button>
                  ) : null}
                  {can('master.category', 'delete') ? (
                    <Button small variant="danger" onClick={() => setPending({ kind: 'delete', cat: c })}>{T.remove}</Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}

      {form ? (
        <CategoryForm
          key={form.mode === 'edit' ? form.cat.id : 'new'}
          cat={form.mode === 'edit' ? form.cat : null}
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
            pending.kind === 'activate' ? T.confirmActivate(pending.cat.name)
              : pending.kind === 'deactivate' ? T.confirmDeactivate(pending.cat.name)
                : T.confirmDelete(pending.cat.name)
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

function CategoryForm({ cat, onClose, onSaved }: { cat: CategoryRow | null; onClose: () => void; onSaved: () => void }) {
  const T = useT(TEXT);
  const [kind, setKind] = useState<Kind>(cat?.kind ?? 'ASSET');
  const [name, setName] = useState(cat?.name ?? '');
  const [nameKo, setNameKo] = useState(cat?.name_ko ?? '');
  const [nameZh, setNameZh] = useState(cat?.name_zh ?? '');
  const [sortOrder, setSortOrder] = useState(String(cat?.sort_order ?? 0));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const kindLocked = cat !== null && cat.model_count > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const sort = Number(sortOrder);
    if (!Number.isInteger(sort)) {
      setError(T.fSortHint);
      return;
    }
    const body = { name: name.trim(), nameKo: nameKo.trim() || null, nameZh: nameZh.trim() || null, sortOrder: sort };
    setBusy(true);
    const r = cat
      ? await api<{ ok: true }>('PATCH', `/api/master/categories/${encodeURIComponent(cat.id)}`, kindLocked ? body : { ...body, kind })
      : await api<{ categoryId: string }>('POST', '/api/master/categories', { ...body, kind });
    setBusy(false);
    if (r.ok) onSaved();
    else if (!r.redirected) setError(r.error.message);
  }

  return (
    <Modal title={cat ? T.formEdit(cat.name) : T.formCreate} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <LabeledField label={T.fKind} hint={kindLocked ? T.fKindLocked : undefined}>
          {(id) => (
            <select id={id} style={smallInput} value={kind} disabled={kindLocked} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="ASSET">{T.kind.ASSET}</option>
              <option value="PERIPHERAL">{T.kind.PERIPHERAL}</option>
            </select>
          )}
        </LabeledField>
        <LabeledField label={T.fName}>
          {(id) => <input id={id} style={smallInput} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />}
        </LabeledField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <LabeledField label={T.fNameKo}>
            {(id) => <input id={id} style={smallInput} value={nameKo} onChange={(e) => setNameKo(e.target.value)} maxLength={80} />}
          </LabeledField>
          <LabeledField label={T.fNameZh}>
            {(id) => <input id={id} style={smallInput} value={nameZh} onChange={(e) => setNameZh(e.target.value)} maxLength={80} />}
          </LabeledField>
        </div>
        <LabeledField label={T.fSort} hint={T.fSortHint}>
          {(id) => <input id={id} type="number" step={1} style={smallInput} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />}
        </LabeledField>
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? T.saving : cat ? T.save : T.create}</Button>
        </div>
      </form>
    </Modal>
  );
}
