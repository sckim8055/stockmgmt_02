'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import {
  api,
  Badge,
  Button,
  CheckboxList,
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
  TempPasswordDialog,
  USER_TYPE_LABEL,
  type CheckOption,
} from '../../../ui';

const T = {
  title: '사용자 관리',
  add: '사용자 추가',
  loading: '불러오는 중…',
  noAccess: '사용자 목록을 볼 권한이 없습니다.',
  empty: '등록된 사용자가 없습니다.',
  colLogin: '로그인 ID',
  colName: '이름',
  colType: '유형',
  colRoles: '역할',
  colScope: '부서 범위',
  colStatus: '상태',
  colActions: '작업',
  allDepartments: '전체',
  noRoles: '-',
  me: '(나)',
  stActive: '활성',
  stInactive: '비활성',
  stLocked: '잠김',
  stMustChange: '비밀번호 변경 필요',
  edit: '수정',
  activate: '활성화',
  deactivate: '비활성화',
  unlock: '잠금 해제',
  tempPassword: '임시 비밀번호 발급',
  confirmActivateTitle: '계정 활성화',
  confirmActivate: (id: string) => `${id} 계정을 활성화합니다.`,
  confirmDeactivateTitle: '계정 비활성화',
  confirmDeactivate: (id: string) => `${id} 계정을 비활성화합니다. 이 계정의 모든 로그인 세션이 즉시 끊깁니다.`,
  confirmUnlockTitle: '잠금 해제',
  confirmUnlock: (id: string) => `${id} 계정의 로그인 잠금을 해제합니다.`,
  confirmTempTitle: '임시 비밀번호 발급',
  confirmTemp: (id: string) =>
    `${id} 계정에 새 임시 비밀번호를 발급합니다. 기존 비밀번호는 더 이상 쓸 수 없고, 이 계정의 로그인 세션이 모두 끊깁니다.`,
  tempIssuedTitle: '임시 비밀번호가 발급되었습니다',
  createdTitle: '사용자를 만들었습니다',
  saved: '저장했습니다.',
  formCreate: '사용자 추가',
  formEdit: (id: string) => `사용자 수정 — ${id}`,
  fLoginId: '로그인 ID',
  fLoginIdHint: '영문·숫자·._@- 3~64자. 만든 뒤에는 바꿀 수 없습니다.',
  fName: '이름',
  fEmail: '이메일 (선택)',
  fLang: '언어',
  fType: '계정 유형',
  fRoles: '역할',
  fRolesEmpty: '배정할 수 있는 활성 역할이 없습니다.',
  fRolesUnavailable: '역할 목록을 볼 권한이 없어 역할을 지정할 수 없습니다.',
  fRolesNotMine: '(내가 갖지 않은 권한 포함)',
  fScope: '부서 범위',
  fScopeHint: '아무 부서도 고르지 않으면 전체 부서입니다.',
  fScopeLimitedHint: '내 부서 범위 안의 부서만 지정할 수 있고, 전체(빈 선택)는 지정할 수 없습니다.',
  fScopeEmpty: '등록된 활성 부서가 없습니다.',
  fScopeUnavailable: '부서 목록을 볼 권한이 없어 부서 범위를 지정할 수 없습니다. (지정하지 않으면 전체 부서)',
  fAdminNote: '기업 관리자는 기업 안의 모든 권한을 가지므로 역할과 부서 범위를 지정하지 않습니다.',
  fSelfNote: '자신의 계정 유형·역할·부서 범위는 스스로 바꿀 수 없습니다.',
  fInactiveSuffix: ' (비활성)',
  cancel: '취소',
  save: '저장',
  create: '만들기',
  saving: '저장 중…',
};

const LANGS: { value: 'ko' | 'en' | 'zh'; label: string }[] = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];

type ManagedType = 'COMPANY_ADMIN' | 'COMPANY_USER';
type Lang = 'ko' | 'en' | 'zh';

interface Ref {
  id: string;
  name: string;
}

interface UserRow {
  id: string;
  login_id: string;
  display_name: string;
  email: string | null;
  user_type: ManagedType;
  lang: string;
  is_active: boolean;
  must_change_password: boolean;
  locked: boolean;
  created_at: string;
  roles: Ref[];
  departments: Ref[];
}

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  user_count: number;
  acl: { resource: string; operation: string }[];
}

interface DepartmentRow {
  id: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
}

/** 보조 목록: 불러오는 중(null) / 권한 없음 / 목록 */
type Optional<T> = null | { unavailable: true; message: string } | { unavailable: false; items: T[] };

type Pending =
  | { kind: 'activate' | 'deactivate' | 'unlock' | 'temp'; user: UserRow }
  | null;

type TempShown = { title: string; loginId: string; password: string } | null;

export default function UsersPage() {
  return (
    <RequireCompany>
      <UsersInner />
    </RequireCompany>
  );
}

function UsersInner() {
  const { me, perms, can } = useShell();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [roles, setRoles] = useState<Optional<RoleRow>>(null);
  const [departments, setDepartments] = useState<Optional<DepartmentRow>>(null);
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; user: UserRow } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  // 임시 비밀번호는 이 상태에만 두고, 대화상자를 닫으면 지운다.
  const [temp, setTemp] = useState<TempShown>(null);
  const [notice, setNotice] = useState('');

  const loadUsers = useCallback(async () => {
    const r = await api<{ users: UserRow[] }>('GET', '/api/admin/users');
    if (r.ok) {
      setUsers(r.data.users);
      setLoadError('');
    } else if (!r.redirected) {
      setLoadError(r.status === 403 ? r.error.message || T.noAccess : r.error.message);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
    void (async () => {
      const r = await api<{ roles: RoleRow[] }>('GET', '/api/admin/roles');
      if (r.ok) setRoles({ unavailable: false, items: r.data.roles });
      else if (!r.redirected) setRoles({ unavailable: true, message: r.status === 403 ? T.fRolesUnavailable : r.error.message });
    })();
    void (async () => {
      const r = await api<{ departments: DepartmentRow[] }>('GET', '/api/departments');
      if (r.ok) setDepartments({ unavailable: false, items: r.data.departments });
      else if (!r.redirected) setDepartments({ unavailable: true, message: r.status === 403 ? T.fScopeUnavailable : r.error.message });
    })();
  }, [loadUsers]);

  // 시스템 관리자는 기업의 사용자 목록에 나오지 않는다. 기업 계정은 같은 기업 안에서 로그인 ID가 유일하다.
  const isSelf = (u: UserRow) => u.id === me.userId;
  // 관리자가 아닌 사용자는 기업 관리자 계정을 관리할 수 없다(서버가 거부한다).
  const manageable = (u: UserRow) => perms.all || u.user_type === 'COMPANY_USER';

  async function runPending(p: NonNullable<Pending>): Promise<string | null> {
    const base = `/api/admin/users/${encodeURIComponent(p.user.id)}`;
    if (p.kind === 'temp') {
      const r = await api<{ tempPassword: string }>('POST', `${base}/temp-password`, {});
      if (!r.ok) return r.redirected ? null : r.error.message;
      setPending(null);
      setTemp({ title: T.tempIssuedTitle, loginId: p.user.login_id, password: r.data.tempPassword });
      void loadUsers();
      return null;
    }
    const r = await api<{ ok: true }>('POST', `${base}/${p.kind}`, {});
    if (!r.ok) return r.redirected ? null : r.error.message;
    setPending(null);
    setNotice(T.saved);
    void loadUsers();
    return null;
  }

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={
          can('admin.user', 'create') ? (
            <Button variant="primary" onClick={() => { setNotice(''); setForm({ mode: 'create' }); }}>{T.add}</Button>
          ) : null
        }
      />
      {notice ? <p role="status" style={{ color: '#166534', fontSize: 14 }}>{notice}</p> : null}
      <ErrorText>{loadError}</ErrorText>

      {users === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {users ? (
        <Table head={[T.colLogin, T.colName, T.colType, T.colRoles, T.colScope, T.colStatus, T.colActions]}>
          {users.length === 0 ? <EmptyRow colSpan={7}>{T.empty}</EmptyRow> : null}
          {users.map((u) => {
            const self = isSelf(u);
            const canManage = manageable(u);
            return (
              <tr key={u.id}>
                <td style={td}>
                  {u.login_id} {self ? <span style={{ color: '#6b7280', fontSize: 12 }}>{T.me}</span> : null}
                </td>
                <td style={td}>
                  {u.display_name}
                  {u.email ? <div style={{ fontSize: 12, color: '#6b7280' }}>{u.email}</div> : null}
                </td>
                <td style={td}>{USER_TYPE_LABEL[u.user_type] ?? u.user_type}</td>
                <td style={td}>
                  {u.user_type === 'COMPANY_ADMIN' ? T.noRoles : u.roles.length ? u.roles.map((r) => r.name).join(', ') : T.noRoles}
                </td>
                <td style={td}>
                  {u.user_type === 'COMPANY_ADMIN' || u.departments.length === 0
                    ? T.allDepartments
                    : u.departments.map((d) => d.name).join(', ')}
                </td>
                <td style={td}>
                  <StatusBadges user={u} />
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {canManage && can('admin.user', 'update') ? (
                      <Button small onClick={() => { setNotice(''); setForm({ mode: 'edit', user: u }); }}>{T.edit}</Button>
                    ) : null}
                    {canManage && !self && !u.is_active && can('admin.user', 'activate') ? (
                      <Button small onClick={() => setPending({ kind: 'activate', user: u })}>{T.activate}</Button>
                    ) : null}
                    {canManage && !self && u.is_active && can('admin.user', 'deactivate') ? (
                      <Button small variant="danger" onClick={() => setPending({ kind: 'deactivate', user: u })}>{T.deactivate}</Button>
                    ) : null}
                    {canManage && u.locked && can('admin.user', 'update') ? (
                      <Button small onClick={() => setPending({ kind: 'unlock', user: u })}>{T.unlock}</Button>
                    ) : null}
                    {canManage && !self && u.is_active && can('admin.user.password', 'execute') ? (
                      <Button small onClick={() => setPending({ kind: 'temp', user: u })}>{T.tempPassword}</Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      ) : null}

      {form ? (
        <UserForm
          key={form.mode === 'edit' ? form.user.id : 'new'}
          user={form.mode === 'edit' ? form.user : null}
          isSelf={form.mode === 'edit' && isSelf(form.user)}
          roles={roles}
          departments={departments}
          onClose={() => setForm(null)}
          onCreated={(loginId, password) => {
            setForm(null);
            setTemp({ title: T.createdTitle, loginId, password });
            void loadUsers();
          }}
          onSaved={() => {
            setForm(null);
            setNotice(T.saved);
            void loadUsers();
          }}
        />
      ) : null}

      {pending ? (
        <ConfirmDialog
          title={
            pending.kind === 'activate' ? T.confirmActivateTitle
              : pending.kind === 'deactivate' ? T.confirmDeactivateTitle
                : pending.kind === 'unlock' ? T.confirmUnlockTitle
                  : T.confirmTempTitle
          }
          message={
            pending.kind === 'activate' ? T.confirmActivate(pending.user.login_id)
              : pending.kind === 'deactivate' ? T.confirmDeactivate(pending.user.login_id)
                : pending.kind === 'unlock' ? T.confirmUnlock(pending.user.login_id)
                  : T.confirmTemp(pending.user.login_id)
          }
          confirmLabel={
            pending.kind === 'activate' ? T.activate
              : pending.kind === 'deactivate' ? T.deactivate
                : pending.kind === 'unlock' ? T.unlock
                  : T.tempPassword
          }
          danger={pending.kind === 'deactivate'}
          onConfirm={() => runPending(pending)}
          onClose={() => setPending(null)}
        />
      ) : null}

      {temp ? (
        <TempPasswordDialog title={temp.title} loginId={temp.loginId} password={temp.password} onClose={() => setTemp(null)} />
      ) : null}
    </div>
  );
}

function StatusBadges({ user }: { user: UserRow }) {
  const badges = [];
  if (!user.is_active) badges.push(<Badge key="i" tone="gray">{T.stInactive}</Badge>);
  if (user.locked) badges.push(<Badge key="l" tone="red">{T.stLocked}</Badge>);
  if (user.must_change_password) badges.push(<Badge key="m" tone="amber">{T.stMustChange}</Badge>);
  if (badges.length === 0) badges.push(<Badge key="a" tone="green">{T.stActive}</Badge>);
  return <>{badges}</>;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function UserForm({
  user,
  isSelf,
  roles,
  departments,
  onClose,
  onCreated,
  onSaved,
}: {
  user: UserRow | null;
  isSelf: boolean;
  roles: Optional<RoleRow>;
  departments: Optional<DepartmentRow>;
  onClose: () => void;
  onCreated: (loginId: string, tempPassword: string) => void;
  onSaved: () => void;
}) {
  const { perms } = useShell();
  const editing = user !== null;
  const origRoleIds = user?.roles.map((r) => r.id) ?? [];
  const origDeptIds = user?.departments.map((d) => d.id) ?? [];

  const [loginId, setLoginId] = useState('');
  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [lang, setLang] = useState<Lang>(((user?.lang as Lang | undefined) ?? 'ko'));
  const [userType, setUserType] = useState<ManagedType>(user?.user_type ?? 'COMPANY_USER');
  const [roleIds, setRoleIds] = useState<string[]>(origRoleIds);
  const [deptIds, setDeptIds] = useState<string[]>(origDeptIds);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 유형은 관리자(all)만 바꿀 수 있고, 자기 계정은 누구도 바꿀 수 없다.
  const canChangeType = perms.all && !isSelf;
  const showAccess = userType === 'COMPANY_USER' && !isSelf;
  const mine = new Set(perms.permissions);
  const limitedScope = !perms.all && perms.departmentScope !== null;
  const myScope = new Set(perms.departmentScope ?? []);

  const roleOptions: CheckOption[] =
    roles && !roles.unavailable
      ? roles.items
          .filter((r) => r.is_active || origRoleIds.includes(r.id))
          .map((r) => {
            const notMine = !perms.all && r.acl.some((a) => !mine.has(`${a.resource}:${a.operation}`));
            return {
              value: r.id,
              label: r.name + (r.is_active ? '' : T.fInactiveSuffix) + (notMine ? ' ' + T.fRolesNotMine : ''),
              // 이미 배정된 것은 해제할 수 있게 둔다. 새로 고를 수 없는 것만 막는다.
              disabled: (!r.is_active || notMine) && !roleIds.includes(r.id),
            };
          })
      : [];
  const deptOptions: CheckOption[] =
    departments && !departments.unavailable
      ? departments.items
          .filter((d) => d.is_active || origDeptIds.includes(d.id))
          .map((d) => ({
            value: d.id,
            label: d.name + (d.is_active ? '' : T.fInactiveSuffix),
            disabled: ((!d.is_active || (limitedScope && !myScope.has(d.id))) && !deptIds.includes(d.id)),
          }))
      : [];

  function changeType(next: ManagedType) {
    setUserType(next);
    if (next === 'COMPANY_ADMIN') {
      // 관리자에게는 역할·범위를 주지 않는다.
      setRoleIds([]);
      setDeptIds([]);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const rolesUsable = roles !== null && !roles.unavailable;
    const deptsUsable = departments !== null && !departments.unavailable;

    if (!editing) {
      const isAdmin = userType === 'COMPANY_ADMIN';
      setBusy(true);
      const r = await api<{ userId: string; tempPassword: string }>('POST', '/api/admin/users', {
        loginId: loginId.trim(),
        displayName,
        email: email.trim() || null,
        lang,
        userType,
        roleIds: isAdmin || !rolesUsable ? [] : roleIds,
        departmentIds: isAdmin || !deptsUsable ? [] : deptIds,
      });
      setBusy(false);
      if (r.ok) onCreated(loginId.trim(), r.data.tempPassword);
      else if (!r.redirected) setError(r.error.message);
      return;
    }

    // 수정: 바뀐 항목만 보낸다(자기 계정이면 유형·역할·범위는 보내지 않는다).
    const body: Record<string, unknown> = {};
    if (displayName !== user.display_name) body.displayName = displayName;
    if ((email.trim() || null) !== (user.email || null)) body.email = email.trim() || null;
    if (lang !== user.lang) body.lang = lang;
    if (!isSelf) {
      if (canChangeType && userType !== user.user_type) body.userType = userType;
      if (userType === 'COMPANY_USER') {
        if (rolesUsable && !sameSet(roleIds, origRoleIds)) body.roleIds = roleIds;
        if (deptsUsable && !sameSet(deptIds, origDeptIds)) body.departmentIds = deptIds;
      }
      // COMPANY_ADMIN 으로 바꾸면 서버가 역할·범위를 비운다.
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    const r = await api<{ ok: true }>('PATCH', `/api/admin/users/${encodeURIComponent(user.id)}`, body);
    setBusy(false);
    if (r.ok) onSaved();
    else if (!r.redirected) setError(r.error.message);
  }

  return (
    <Modal title={editing ? T.formEdit(user.login_id) : T.formCreate} onClose={onClose} width={560}>
      <form onSubmit={submit}>
        {!editing ? (
          <LabeledField label={T.fLoginId} hint={T.fLoginIdHint}>
            {(id) => (
              <input id={id} style={smallInput} value={loginId} onChange={(e) => setLoginId(e.target.value)} required minLength={3} maxLength={64} autoComplete="off" />
            )}
          </LabeledField>
        ) : null}
        <LabeledField label={T.fName}>
          {(id) => <input id={id} style={smallInput} value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={100} />}
        </LabeledField>
        <LabeledField label={T.fEmail}>
          {(id) => <input id={id} type="email" style={smallInput} value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} autoComplete="off" />}
        </LabeledField>
        <LabeledField label={T.fLang}>
          {(id) => (
            <select id={id} style={smallInput} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
              {LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          )}
        </LabeledField>
        <LabeledField label={T.fType}>
          {(id) =>
            canChangeType ? (
              <select id={id} style={smallInput} value={userType} onChange={(e) => changeType(e.target.value as ManagedType)}>
                <option value="COMPANY_USER">{USER_TYPE_LABEL.COMPANY_USER}</option>
                <option value="COMPANY_ADMIN">{USER_TYPE_LABEL.COMPANY_ADMIN}</option>
              </select>
            ) : (
              <input id={id} style={{ ...smallInput, background: '#f5f6f8' }} value={USER_TYPE_LABEL[userType]} readOnly />
            )
          }
        </LabeledField>

        {isSelf ? <Notice>{T.fSelfNote}</Notice> : null}
        {!isSelf && userType === 'COMPANY_ADMIN' ? <Notice>{T.fAdminNote}</Notice> : null}

        {showAccess ? (
          <>
            {roles === null ? (
              <p style={{ fontSize: 13, color: '#6b7280' }}>{T.loading}</p>
            ) : roles.unavailable ? (
              <p style={{ fontSize: 13, color: '#6b7280' }}>{roles.message}</p>
            ) : (
              <CheckboxList legend={T.fRoles} options={roleOptions} selected={roleIds} onChange={setRoleIds} emptyText={T.fRolesEmpty} />
            )}
            {departments === null ? (
              <p style={{ fontSize: 13, color: '#6b7280' }}>{T.loading}</p>
            ) : departments.unavailable ? (
              <p style={{ fontSize: 13, color: '#6b7280' }}>{departments.message}</p>
            ) : (
              <CheckboxList
                legend={T.fScope}
                hint={limitedScope ? T.fScopeLimitedHint : T.fScopeHint}
                options={deptOptions}
                selected={deptIds}
                onChange={setDeptIds}
                emptyText={T.fScopeEmpty}
              />
            )}
          </>
        ) : null}

        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? T.saving : editing ? T.save : T.create}</Button>
        </div>
      </form>
    </Modal>
  );
}
