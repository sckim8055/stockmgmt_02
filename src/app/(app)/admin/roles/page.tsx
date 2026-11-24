'use client';
import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import {
  api,
  Badge,
  Button,
  ConfirmDialog,
  EmptyRow,
  ErrorText,
  LabeledField,
  Modal,
  Notice,
  PageHeader,
  smallInput,
  Table,
  td,
  th,
} from '../../../ui';
import { OPERATIONS, useResourceLabels } from '../resource-labels';
import { useT } from '../../../i18n';
import { TEXT } from './page.text';

interface AclEntry {
  resource: string;
  operation: string;
}

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  user_count: number;
  acl: AclEntry[];
}

interface ResourceRow {
  code: string;
  parent_code: string | null;
  type: 'MENU' | 'PAGE' | 'FIELD';
  sort_order: number;
  operations: string[];
}

interface Group {
  menu: ResourceRow | null;
  pages: { page: ResourceRow; fields: ResourceRow[] }[];
}

const key = (resource: string, operation: string) => `${resource}:${operation}`;
const bySort = (a: ResourceRow, b: ResourceRow) => a.sort_order - b.sort_order || a.code.localeCompare(b.code);

/** 메뉴 > 페이지 > 필드 트리. system.* 는 역할에 넣을 수 없으므로 뺀다. */
function buildTree(resources: ResourceRow[]): Group[] {
  const rows = resources.filter((r) => !r.code.startsWith('system.'));
  const menus = rows.filter((r) => r.type === 'MENU').sort(bySort);
  const pages = rows.filter((r) => r.type === 'PAGE').sort(bySort);
  const fields = rows.filter((r) => r.type === 'FIELD').sort(bySort);
  const menuCodes = new Set(menus.map((m) => m.code));
  const withFields = (p: ResourceRow) => ({ page: p, fields: fields.filter((f) => f.parent_code === p.code) });

  const groups: Group[] = menus.map((m) => ({ menu: m, pages: pages.filter((p) => p.parent_code === m.code).map(withFields) }));
  const orphans = pages.filter((p) => !p.parent_code || !menuCodes.has(p.parent_code));
  if (orphans.length) groups.push({ menu: null, pages: orphans.map(withFields) });
  return groups;
}

type Pending = { kind: 'activate' | 'deactivate' | 'delete'; role: RoleRow } | null;

export default function RolesPage() {
  return (
    <RequireCompany>
      <RolesInner />
    </RequireCompany>
  );
}

function RolesInner() {
  const T = useT(TEXT);
  const { perms, can } = useShell();
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [resources, setResources] = useState<ResourceRow[] | null>(null);
  const [resourceError, setResourceError] = useState('');
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; role: RoleRow } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState('');

  const loadRoles = useCallback(async () => {
    const r = await api<{ roles: RoleRow[] }>('GET', '/api/admin/roles');
    if (r.ok) {
      setRoles(r.data.roles);
      setLoadError('');
    } else if (!r.redirected) setLoadError(r.error.message);
  }, []);

  useEffect(() => {
    void loadRoles();
    void (async () => {
      const r = await api<{ resources: ResourceRow[] }>('GET', '/api/admin/resources');
      if (r.ok) setResources(r.data.resources);
      else if (!r.redirected) setResourceError(r.error.message || T.resourcesFailed);
    })();
  }, [loadRoles]);

  const mine = new Set(perms.permissions);
  const withinMine = (role: RoleRow) => perms.all || role.acl.every((a) => mine.has(key(a.resource, a.operation)));

  async function runPending(p: NonNullable<Pending>): Promise<string | null> {
    const url = `/api/admin/roles/${encodeURIComponent(p.role.id)}`;
    const r =
      p.kind === 'delete'
        ? await api<{ ok: true }>('DELETE', url)
        : await api<{ ok: true }>('PATCH', url, { isActive: p.kind === 'activate' });
    if (!r.ok) return r.redirected ? null : r.error.message;
    setPending(null);
    setNotice(T.saved);
    void loadRoles();
    return null;
  }

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={
          can('admin.role', 'create') ? (
            <Button variant="primary" disabled={!resources} onClick={() => { setNotice(''); setForm({ mode: 'create' }); }}>{T.add}</Button>
          ) : null
        }
      />
      {notice ? <p role="status" style={{ color: '#166534', fontSize: 14 }}>{notice}</p> : null}
      <ErrorText>{loadError}</ErrorText>
      <ErrorText>{resourceError}</ErrorText>

      {roles === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {roles ? (
        <Table head={[T.colName, T.colDesc, T.colStatus, T.colUsers, T.colActions]}>
          {roles.length === 0 ? <EmptyRow colSpan={5}>{T.empty}</EmptyRow> : null}
          {roles.map((role) => {
            const ok = withinMine(role);
            const blocked = ok ? undefined : T.notMine;
            return (
              <tr key={role.id}>
                <td style={td}>{role.name}</td>
                <td style={{ ...td, color: '#4b5563' }}>{role.description ?? ''}</td>
                <td style={td}>{role.is_active ? <Badge tone="green">{T.active}</Badge> : <Badge tone="gray">{T.inactive}</Badge>}</td>
                <td style={{ ...td, textAlign: 'right' }}>{role.user_count}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {can('admin.role', 'update') ? (
                      <>
                        <Button small disabled={!ok || !resources} title={blocked} onClick={() => { setNotice(''); setForm({ mode: 'edit', role }); }}>{T.edit}</Button>
                        {role.is_active ? (
                          <Button small variant="danger" disabled={!ok} title={blocked} onClick={() => setPending({ kind: 'deactivate', role })}>{T.deactivate}</Button>
                        ) : (
                          <Button small disabled={!ok} title={blocked} onClick={() => setPending({ kind: 'activate', role })}>{T.activate}</Button>
                        )}
                      </>
                    ) : null}
                    {can('admin.role', 'delete') ? (
                      <Button small variant="danger" disabled={!ok} title={blocked} onClick={() => setPending({ kind: 'delete', role })}>{T.remove}</Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      ) : null}

      {form && resources ? (
        <RoleForm
          key={form.mode === 'edit' ? form.role.id : 'new'}
          role={form.mode === 'edit' ? form.role : null}
          resources={resources}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            setNotice(T.saved);
            void loadRoles();
          }}
        />
      ) : null}

      {pending ? (
        <ConfirmDialog
          title={pending.kind === 'activate' ? T.confirmActivateTitle : pending.kind === 'deactivate' ? T.confirmDeactivateTitle : T.confirmDeleteTitle}
          message={
            pending.kind === 'activate' ? T.confirmActivate(pending.role.name)
              : pending.kind === 'deactivate' ? T.confirmDeactivate(pending.role.name)
                : T.confirmDelete(pending.role.name)
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

function RoleForm({
  role,
  resources,
  onClose,
  onSaved,
}: {
  role: RoleRow | null;
  resources: ResourceRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const RL = useResourceLabels();
  const T = useT(TEXT);
  const { perms } = useShell();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(() => new Set((role?.acl ?? []).map((a) => key(a.resource, a.operation))));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const mine = new Set(perms.permissions);
  const grantable = (resource: string, op: string) => perms.all || mine.has(key(resource, op));
  const tree = buildTree(resources);
  const hasForeign = !perms.all && [...selected].some((k) => !mine.has(k));

  function toggle(k: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(k);
      else next.delete(k);
      return next;
    });
  }

  function toggleRow(r: ResourceRow, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const op of r.operations) {
        if (!grantable(r.code, op)) continue;
        if (on) next.add(key(r.code, op));
        else next.delete(key(r.code, op));
      }
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const acl: AclEntry[] = [...selected].map((k) => {
      const i = k.lastIndexOf(':');
      return { resource: k.slice(0, i), operation: k.slice(i + 1) };
    });
    const body = { name: name.trim(), description: description.trim() || null, acl };
    setBusy(true);
    const r = role
      ? await api<{ ok: true }>('PATCH', `/api/admin/roles/${encodeURIComponent(role.id)}`, body)
      : await api<{ roleId: string }>('POST', '/api/admin/roles', body);
    setBusy(false);
    if (r.ok) onSaved();
    else if (!r.redirected) setError(r.error.message);
  }

  function renderRow(r: ResourceRow, depth: 1 | 2) {
    const rowGrantable = r.operations.filter((op) => grantable(r.code, op));
    const allOn = rowGrantable.length > 0 && rowGrantable.every((op) => selected.has(key(r.code, op)));
    const rowName = RL.label(r.code);
    return (
      <tr key={r.code}>
        <th scope="row" style={{ ...td, textAlign: 'left', fontWeight: depth === 1 ? 500 : 400, paddingLeft: depth === 1 ? 18 : 38, whiteSpace: 'nowrap' }}>
          {depth === 2 ? '└ ' : ''}
          {rowName}
          <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>{r.code}</div>
        </th>
        <td style={{ ...td, textAlign: 'center' }}>
          {r.operations.length ? (
            <input
              type="checkbox"
              aria-label={T.rowAll(rowName)}
              checked={allOn}
              disabled={rowGrantable.length === 0}
              onChange={(e) => toggleRow(r, e.target.checked)}
            />
          ) : null}
        </td>
        {OPERATIONS.map((op) => {
          if (!r.operations.includes(op)) return <td key={op} style={td} />;
          const k = key(r.code, op);
          return (
            <td key={op} style={{ ...td, textAlign: 'center' }}>
              <input
                type="checkbox"
                aria-label={T.cellLabel(rowName, RL.op[op])}
                checked={selected.has(k)}
                disabled={!grantable(r.code, op)}
                onChange={(e) => toggle(k, e.target.checked)}
              />
            </td>
          );
        })}
      </tr>
    );
  }

  return (
    <Modal title={role ? T.formEdit(role.name) : T.formCreate} onClose={onClose} width={1040}>
      <form onSubmit={submit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
          <LabeledField label={T.fName}>
            {(id) => <input id={id} style={smallInput} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />}
          </LabeledField>
          <LabeledField label={T.fDesc}>
            {(id) => <input id={id} style={smallInput} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />}
          </LabeledField>
        </div>

        <h3 style={{ fontSize: 15, margin: '4px 0 4px' }}>{T.fMatrix}</h3>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>{perms.all ? T.fMatrixHintAll : T.fMatrixHint}</p>
        {hasForeign ? <Notice>{T.fNotMineWarn}</Notice> : null}

        <div style={{ maxHeight: '55vh', overflow: 'auto', border: '1px solid #e2e5ea' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, background: '#fff' }}>
            <thead>
              <tr>
                <th scope="col" style={{ ...th, position: 'sticky', top: 0 }}>{T.colResource}</th>
                <th scope="col" style={{ ...th, position: 'sticky', top: 0, textAlign: 'center' }}>{T.colAll}</th>
                {OPERATIONS.map((op) => (
                  <th key={op} scope="col" style={{ ...th, position: 'sticky', top: 0, textAlign: 'center' }}>{RL.op[op]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tree.map((g) => (
                <Fragment key={g.menu?.code ?? '__other'}>
                  <tr>
                    <th scope="rowgroup" colSpan={OPERATIONS.length + 2} style={{ ...td, textAlign: 'left', background: '#f7f8fa', fontWeight: 700 }}>
                      {g.menu ? RL.label(g.menu.code) : T.other}
                    </th>
                  </tr>
                  {g.pages.map(({ page, fields }) => (
                    <Fragment key={page.code}>
                      {renderRow(page, 1)}
                      {fields.map((f) => renderRow(f, 2))}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? T.saving : role ? T.save : T.create}</Button>
        </div>
      </form>
    </Modal>
  );
}
