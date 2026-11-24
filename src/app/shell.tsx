'use client';
// 로그인한 화면들이 함께 쓰는 틀: 상단 바(사용자·기업·로그아웃)와 왼쪽 메뉴.
// 메뉴와 버튼은 /api/me/permissions 로 그리지만 화면 편의일 뿐이다. 실제 판정은 각 API가 다시 한다.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { api, Button, ErrorText, USER_TYPE_LABEL, type UserType, setExpectedCompany } from './ui';

const T = {
  product: 'StockMgmt',
  loading: '불러오는 중…',
  loadFailed: '사용자 정보를 불러오지 못했습니다.',
  retry: '다시 시도',
  logout: '로그아웃',
  company: '기업',
  companyOwn: '소속 기업',
  actingCompany: '작업 기업',
  noCompany: '선택 해제 (기업 없음)',
  inactive: '(비활성)',
  companiesFailed: '기업 목록을 불러오지 못했습니다.',
  switching: '전환 중…',
  navHome: '홈',
  navUsers: '사용자 관리',
  navRoles: '역할 관리',
  navCompanies: '기업 관리',
  navAssets: '자산',
  navPeripheralGroup: '주변기기',
  navPeripheralStock: '재고',
  navPeripheralLoans: '대여 현황',
  navImport: '엑셀 업로드',
  navMasterGroup: '기준 정보',
  navCategories: '카테고리',
  navModels: '모델',
  navDepartments: '부서',
  navPersons: '직원',
  navCustomFields: '사용자 지정 필드',
  navAdminGroup: '관리',
  navAlertGroup: '알림',
  navAlertInbox: '알림함',
  navThresholds: '한계 수량',
  navMailGroup: '메일',
  navMailSchedules: '메일 일정',
  navMailLogs: '발송 기록',
  unreadBadge: (n: number) => (n > 99 ? '99+' : String(n)),
  unreadLabel: (n: number) => `읽지 않은 알림 ${n}건`,
  navLabel: '주 메뉴',
  pickCompany: '상단 바에서 작업할 기업을 먼저 선택하세요.',
};

export interface Me {
  userId: string;
  loginId: string;
  displayName: string;
  userType: UserType;
  lang: string;
  companyId: string | null;
  actingCompanyId: string | null;
  /** 작업 대상 기업(소속 기업 또는 시스템 관리자가 고른 기업)의 코드와 이름 */
  company: { id: string; code: string; name: string } | null;
  mustChangePassword: boolean;
}

export interface MyPermissions {
  all: boolean;
  companyId: string | null;
  permissions: string[];
  departmentScope: string[] | null;
}

export interface Company {
  id: string;
  code: string;
  name: string;
  timezone: string;
  locale: string;
  is_active: boolean;
  created_at: string;
}

interface ShellValue {
  me: Me;
  perms: MyPermissions;
  /** 권한 표시용 판정. all 이면 기업 안의 모든 권한을 가진 것으로 본다. */
  can: (resource: string, operation: string) => boolean;
  /** 권한 판정과 데이터의 기준이 되는 기업(소속 기업 또는 시스템 관리자가 고른 기업). */
  effectiveCompanyId: string | null;
  /** 시스템 관리자일 때만 채워진다. */
  companies: Company[];
  reloadCompanies: () => Promise<void>;
  /** 알림함 화면이 방금 받은 읽지 않은 알림 수로 메뉴의 표시를 맞춘다(따로 다시 묻지 않는다). */
  syncUnread: (count: number) => void;
}

const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const v = useContext(ShellContext);
  if (!v) throw new Error('useShell 은 AppShell 안에서만 쓴다.');
  return v;
}

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; me: Me; perms: MyPermissions };

export function AppShell({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyError, setCompanyError] = useState('');
  // 기업을 바꾸면 이 값을 올려 아래 화면을 새로 그린다(각 화면이 데이터를 다시 불러온다).
  const [generation, setGeneration] = useState(0);
  // 읽지 않은 알림 수. null = 모름(권한 없음·불러오기 전·실패). 주기적으로 묻지 않는다:
  // 화면을 처음 열 때와 기업을 바꿀 때만 부른다. 알림함 화면은 자기가 받은 건수로 맞춘다(syncUnread).
  const [unread, setUnread] = useState<number | null>(null);

  const loadCompanies = useCallback(async () => {
    const r = await api<{ companies: Company[] }>('GET', '/api/system/companies');
    if (r.ok) {
      setCompanies(r.data.companies);
      setCompanyError('');
    } else if (!r.redirected) {
      setCompanyError(r.error.message || T.companiesFailed);
    }
  }, []);

  const load = useCallback(async () => {
    const meRes = await api<{ user: Me }>('GET', '/api/me');
    if (!meRes.ok) {
      if (!meRes.redirected) setState({ kind: 'error', message: meRes.error.message || T.loadFailed });
      return;
    }
    const me = meRes.data.user;
    if (me.mustChangePassword) {
      window.location.href = '/change-password';
      return;
    }
    const permRes = await api<MyPermissions>('GET', '/api/me/permissions');
    if (!permRes.ok) {
      if (!permRes.redirected) setState({ kind: 'error', message: permRes.error.message || T.loadFailed });
      return;
    }
    setState({ kind: 'ready', me, perms: permRes.data });
    if (me.userType === 'SYSTEM_ADMIN') await loadCompanies();
  }, [loadCompanies]);

  const loadUnread = useCallback(async () => {
    // pageSize=1: 건수만 필요하다(알림 내용은 알림함 화면이 불러온다).
    const r = await api<{ unread: number }>('GET', '/api/alerts?pageSize=1');
    setUnread(r.ok ? r.data.unread : null);
  }, []);

  // 알림함 조회 권한이 있고 기업이 정해진 경우에만 부른다. 기업이 바뀌면(state 가 새로 바뀌면) 다시 부른다.
  const unreadEnabled =
    state.kind === 'ready' &&
    (state.perms.all || state.perms.permissions.includes('alert.inbox:read')) &&
    Boolean(state.me.companyId ?? state.me.actingCompanyId);
  useEffect(() => {
    if (unreadEnabled) void loadUnread();
    else setUnread(null);
  }, [unreadEnabled, state, loadUnread]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') {
    return <p style={{ padding: 24, color: '#6b7280' }}>{T.loading}</p>;
  }
  if (state.kind === 'error') {
    return (
      <main style={{ padding: 24 }}>
        <ErrorText>{state.message}</ErrorText>
        <Button onClick={() => { setState({ kind: 'loading' }); void load(); }}>{T.retry}</Button>
      </main>
    );
  }

  const { me, perms } = state;
  // 자식 화면이 데이터를 부르기 전에 맞춰 둔다(자식의 effect 가 부모의 effect 보다 먼저 실행되므로 렌더 중에 설정한다).
  setExpectedCompany(me.companyId ?? me.actingCompanyId);
  const permSet = new Set(perms.permissions);
  const can = (resource: string, operation: string) => perms.all || permSet.has(`${resource}:${operation}`);
  const value: ShellValue = {
    me,
    perms,
    can,
    effectiveCompanyId: me.companyId ?? me.actingCompanyId,
    companies,
    reloadCompanies: loadCompanies,
    syncUnread: setUnread,
  };

  const onCompanyChanged = async () => {
    await load();
    setGeneration((g) => g + 1);
  };

  return (
    <ShellContext.Provider value={value}>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <TopBar me={me} companies={companies} companyError={companyError} onCompanyChanged={onCompanyChanged} />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <SideNav me={me} can={can} unread={unread} />
          <main key={generation} style={{ flex: 1, padding: '20px 24px', minWidth: 0 }}>
            {children}
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}

function TopBar({
  me,
  companies,
  companyError,
  onCompanyChanged,
}: {
  me: Me;
  companies: Company[];
  companyError: string;
  onCompanyChanged: () => Promise<void>;
}) {
  const selectId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function selectCompany(companyId: string) {
    setBusy(true);
    setError('');
    const r = await api<{ ok: true }>('POST', '/api/system/acting-company', { companyId: companyId || null });
    if (r.ok) await onCompanyChanged();
    else if (!r.redirected) setError(r.error.message);
    setBusy(false);
  }

  return (
    <header
      style={{
        display: 'flex', alignItems: 'center', gap: 16, padding: '10px 20px', background: '#1f2937', color: '#f9fafb',
        flexWrap: 'wrap',
      }}
    >
      <Link href="/" style={{ color: '#fff', textDecoration: 'none', fontWeight: 700, fontSize: 16 }}>{T.product}</Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        {me.userType === 'SYSTEM_ADMIN' ? (
          <>
            <label htmlFor={selectId}>{T.actingCompany}</label>
            <select
              id={selectId}
              value={me.actingCompanyId ?? ''}
              disabled={busy}
              onChange={(e) => void selectCompany(e.target.value)}
              style={{ padding: '4px 6px', borderRadius: 5, border: '1px solid #4b5563', fontSize: 13, maxWidth: 260 }}
            >
              <option value="">{T.noCompany}</option>
              {companies.map((c) => (
                // 비활성 기업은 서버가 선택을 거부하므로 고를 수 없게 둔다.
                <option key={c.id} value={c.id} disabled={!c.is_active}>
                  {c.name} ({c.code}){c.is_active ? '' : ' ' + T.inactive}
                </option>
              ))}
            </select>
            {busy ? <span>{T.switching}</span> : null}
          </>
        ) : (
          <span>
            {T.companyOwn}: <span style={{ color: '#d1d5db' }}>{me.company ? `${me.company.name} (${me.company.code})` : '-'}</span>
          </span>
        )}
      </div>
      {error || companyError ? (
        <span role="alert" style={{ color: '#fecaca', fontSize: 13 }}>{error || companyError}</span>
      ) : null}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
        <span>
          {me.displayName} <span style={{ color: '#9ca3af' }}>({me.loginId} · {USER_TYPE_LABEL[me.userType] ?? me.userType})</span>
        </span>
        <Button
          small
          onClick={async () => {
            await api<{ ok: true }>('POST', '/api/auth/logout', {});
            window.location.href = '/login';
          }}
        >
          {T.logout}
        </Button>
      </div>
    </header>
  );
}

/** 화면에는 보이지 않고 화면 낭독기만 읽는 글자 */
const srOnly = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;

interface NavItem {
  href: string;
  label: string;
  /** 하위 경로에 다른 메뉴가 있으면(예: /peripherals 아래 /peripherals/loans) 정확히 같을 때만 선택 표시한다. */
  exact?: boolean;
  /** 항목 옆에 붙이는 건수 표시 */
  count?: number | null;
}
interface NavSection {
  /** 묶음 제목. 없으면 제목 없이 항목만 그린다. */
  title?: string;
  items: NavItem[];
}

function SideNav({ me, can, unread }: { me: Me; can: (resource: string, operation: string) => boolean; unread: number | null }) {
  const pathname = usePathname();
  const main: NavItem[] = [{ href: '/', label: T.navHome }];
  if (can('asset.item', 'read')) main.push({ href: '/assets', label: T.navAssets });
  if (can('master.person', 'import') || can('asset.item', 'import') || can('peripheral.receive', 'execute')) {
    main.push({ href: '/import', label: T.navImport });
  }

  const peripheral: NavItem[] = [];
  if (can('peripheral.stock', 'read')) peripheral.push({ href: '/peripherals', label: T.navPeripheralStock, exact: true });
  if (can('peripheral.loan', 'read')) peripheral.push({ href: '/peripherals/loans', label: T.navPeripheralLoans });

  const master: NavItem[] = [];
  if (can('master.category', 'read')) master.push({ href: '/master/categories', label: T.navCategories });
  if (can('master.model', 'read')) master.push({ href: '/master/models', label: T.navModels });
  if (can('master.department', 'read')) master.push({ href: '/master/departments', label: T.navDepartments });
  if (can('master.person', 'read')) master.push({ href: '/master/persons', label: T.navPersons });
  if (can('master.custom_field', 'read')) master.push({ href: '/master/custom-fields', label: T.navCustomFields });

  const alert: NavItem[] = [];
  if (can('alert.inbox', 'read')) alert.push({ href: '/alerts', label: T.navAlertInbox, count: unread });
  if (can('threshold', 'read')) alert.push({ href: '/thresholds', label: T.navThresholds });

  const mail: NavItem[] = [];
  if (can('mail.schedule', 'read')) mail.push({ href: '/mail/schedules', label: T.navMailSchedules });
  if (can('mail.log', 'read')) mail.push({ href: '/mail/logs', label: T.navMailLogs });

  const admin: NavItem[] = [];
  if (can('admin.user', 'read')) admin.push({ href: '/admin/users', label: T.navUsers });
  if (can('admin.role', 'read')) admin.push({ href: '/admin/roles', label: T.navRoles });
  if (me.userType === 'SYSTEM_ADMIN') admin.push({ href: '/system/companies', label: T.navCompanies });

  const sections: NavSection[] = [
    { items: main },
    { title: T.navPeripheralGroup, items: peripheral },
    { title: T.navAlertGroup, items: alert },
    { title: T.navMailGroup, items: mail },
    { title: T.navMasterGroup, items: master },
    { title: T.navAdminGroup, items: admin },
  ].filter((sec) => sec.items.length > 0);

  return (
    <nav aria-label={T.navLabel} style={{ width: 180, flexShrink: 0, background: '#fff', borderRight: '1px solid #e2e5ea', padding: '14px 0' }}>
      {sections.map((sec, i) => (
        <div key={sec.title ?? `section-${i}`} style={{ marginTop: i === 0 ? 0 : 12 }}>
          {sec.title ? (
            <div style={{ padding: '4px 18px', fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{sec.title}</div>
          ) : null}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label={sec.title}>
            {sec.items.map((it) => {
              const active = it.href === '/' || it.exact ? pathname === it.href : pathname === it.href || pathname.startsWith(it.href + '/');
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    aria-current={active ? 'page' : undefined}
                    style={{
                      display: 'block', padding: '8px 18px', fontSize: 14, textDecoration: 'none',
                      color: active ? '#1d4ed8' : '#1f2937', background: active ? '#eef4ff' : 'transparent',
                      borderLeft: active ? '3px solid #2563eb' : '3px solid transparent',
                    }}
                  >
                    {it.label}
                    {it.count ? (
                      <>
                        <span
                          aria-hidden="true"
                          style={{ marginLeft: 6, display: 'inline-block', minWidth: 18, padding: '0 6px', borderRadius: 9, background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 600, lineHeight: '18px', textAlign: 'center' }}
                        >
                          {T.unreadBadge(it.count)}
                        </span>
                        <span style={srOnly}>{` (${T.unreadLabel(it.count)})`}</span>
                      </>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** 시스템 관리자가 기업을 고르지 않았으면 안내하고, 그렇지 않으면 children 을 그린다. */
export function RequireCompany({ children }: { children: ReactNode }) {
  const { me, effectiveCompanyId } = useShell();
  if (me.userType === 'SYSTEM_ADMIN' && !effectiveCompanyId) {
    return (
      <p style={{ background: '#fff', border: '1px solid #e2e5ea', borderRadius: 6, padding: '12px 14px', fontSize: 14 }}>
        {T.pickCompany}
      </p>
    );
  }
  return <>{children}</>;
}
