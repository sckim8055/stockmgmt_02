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

const T = {
  title: '역할 관리',
  add: '역할 추가',
  loading: '불러오는 중…',
  empty: '등록된 역할이 없습니다.',
  colName: '이름',
  colDesc: '설명',
  colStatus: '상태',
  colUsers: '사용자 수',
  colActions: '작업',
  active: '활성',
  inactive: '비활성',
  edit: '수정',
  activate: '활성화',
  deactivate: '비활성화',
  remove: '삭제',
  notMine: '내가 갖지 않은 권한이 포함된 역할이라 관리할 수 없습니다.',
  confirmActivateTitle: '역할 활성화',
  confirmActivate: (n: string) => `"${n}" 역할을 활성화합니다. 이 역할이 배정된 사용자가 역할의 권한을 다시 갖게 됩니다.`,
  confirmDeactivateTitle: '역할 비활성화',
  confirmDeactivate: (n: string) => `"${n}" 역할을 비활성화합니다. 이 역할이 배정된 사용자는 역할의 권한을 즉시 잃습니다.`,
  confirmDeleteTitle: '역할 삭제',
  confirmDelete: (n: string) => `"${n}" 역할을 삭제합니다. 사용자에게 배정된 역할은 삭제할 수 없습니다.`,
  saved: '저장했습니다.',
  formCreate: '역할 추가',
  formEdit: (n: string) => `역할 수정 — ${n}`,
  fName: '이름',
  fDesc: '설명 (선택)',
  fMatrix: '권한',
  fMatrixHint: '체크한 동작만 허용됩니다. 내가 갖지 않은 권한은 줄 수 없어 비활성으로 표시됩니다.',
  fMatrixHintAll: '체크한 동작만 허용됩니다.',
  fNotMineWarn: '이 역할에는 내가 갖지 않은 권한이 들어 있어 저장할 수 없습니다.',
  resourcesFailed: '권한 목록을 불러오지 못했습니다.',
  colResource: '화면 / 항목',
  colAll: '전체',
  rowAll: (r: string) => `${r} 전체`,
  cellLabel: (r: string, op: string) => `${r} ${op}`,
  other: '기타',
  cancel: '취소',
  save: '저장',
  create: '만들기',
  saving: '저장 중…',
};

/** 동작 열. 순서는 화면 표시 순서다. */
const OPERATIONS = ['read', 'create', 'update', 'delete', 'activate', 'deactivate', 'import', 'export', 'execute'] as const;
const OP_LABEL: Record<(typeof OPERATIONS)[number], string> = {
  read: '조회',
  create: '등록',
  update: '수정',
  delete: '삭제',
  activate: '활성화',
  deactivate: '비활성화',
  import: '가져오기',
  export: '내보내기',
  execute: '실행',
};

/** 리소스 코드의 화면 이름. 목록에 없는 코드는 코드를 그대로 보여 준다. */
const RESOURCE_LABEL: Record<string, string> = {
  'menu.dashboard': '대시보드',
  'menu.asset': '자산',
  'menu.peripheral': '주변기기',
  'menu.master': '기준정보',
  'menu.alert': '알림',
  'menu.mail': '메일',
  'menu.history': '이력',
  'menu.admin': '관리',
  dashboard: '대시보드',
  'asset.item': '자산 목록',
  'asset.assign': '자산 배정',
  'asset.maintain': '자산 유지보수',
  'asset.retire': '자산 폐기',
  'peripheral.stock': '주변기기 재고',
  'peripheral.receive': '입고',
  'peripheral.issue': '출고',
  'peripheral.adjust': '재고 조정',
  'peripheral.loan': '대여 현황',
  'master.category': '분류',
  'master.model': '모델',
  'master.department': '부서',
  'master.person': '직원',
  'master.custom_field': '사용자 정의 항목',
  threshold: '재고 기준치',
  'alert.inbox': '알림함',
  'mail.schedule': '메일 일정',
  'mail.log': '메일 발송 기록',
  'history.stock': '재고 이력',
  'history.audit': '감사 로그',
  'admin.user': '사용자 관리',
  'admin.user.password': '임시 비밀번호 발급',
  'admin.role': '역할 관리',
  'asset.item.purchase_price': '구매 가격',
  'asset.item.supplier': '공급업체',
  'asset.item.custom_restricted': '제한 사용자 정의 항목',
};
const label = (code: string) => RESOURCE_LABEL[code] ?? code;

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
    const rowName = label(r.code);
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
                aria-label={T.cellLabel(rowName, OP_LABEL[op])}
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
                  <th key={op} scope="col" style={{ ...th, position: 'sticky', top: 0, textAlign: 'center' }}>{OP_LABEL[op]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tree.map((g) => (
                <Fragment key={g.menu?.code ?? '__other'}>
                  <tr>
                    <th scope="rowgroup" colSpan={OPERATIONS.length + 2} style={{ ...td, textAlign: 'left', background: '#f7f8fa', fontWeight: 700 }}>
                      {g.menu ? label(g.menu.code) : T.other}
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
