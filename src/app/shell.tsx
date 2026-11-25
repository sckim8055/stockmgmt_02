'use client';
// 로그인한 화면들이 함께 쓰는 틀: 상단 바(사용자·기업·로그아웃)와 왼쪽 메뉴.
// 메뉴와 버튼은 /api/me/permissions 로 그리지만 화면 편의일 뿐이다. 실제 판정은 각 API가 다시 한다.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { api, Button, ErrorText, useUserTypeLabel, type UserType, setExpectedCompany } from './ui';
import { useLangControl, type Lang } from './i18n';
import { LangSwitcher } from './i18n/switcher';
import { useT } from './i18n';
import { TEXT } from './shell.text';

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
  if (!v) throw new Error('useShell must be used inside AppShell'); // 개발자 오류(화면 문구가 아니다)
  return v;
}

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; me: Me; perms: MyPermissions };

export function AppShell({ children }: { children: ReactNode }) {
  const T = useT(TEXT);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const { adoptUserLang } = useLangControl();
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
    // 사용자의 언어를 기본값으로 쓴다(이 브라우저에서 고른 언어가 있으면 그것이 우선).
    adoptUserLang(me.lang);
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
  }, [loadCompanies, adoptUserLang]);

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
    return <p style={{ padding: 24, color: 'var(--text-muted)' }}>{T.loading}</p>;
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
      <ShellFrame me={me} can={can} unread={unread} companies={companies} companyError={companyError} onCompanyChanged={onCompanyChanged}>
        <main key={generation} className="shell__content">
          {children}
        </main>
      </ShellFrame>
    </ShellContext.Provider>
  );
}

/**
 * 사이드바(넓은 화면) / 서랍 메뉴(좁은 화면)와 상단 바의 배치.
 * 서랍은 화면 모양만 바꾼다: 메뉴 항목과 권한 판정은 SideNav 그대로다.
 */
function ShellFrame({
  me,
  can,
  unread,
  companies,
  companyError,
  onCompanyChanged,
  children,
}: {
  me: Me;
  can: (resource: string, operation: string) => boolean;
  unread: number | null;
  companies: Company[];
  companyError: string;
  onCompanyChanged: () => Promise<void>;
  children: ReactNode;
}) {
  const T = useT(TEXT);
  const pathname = usePathname();
  const navId = useId();
  const [open, setOpen] = useState(false);

  // 메뉴에서 화면을 고르면 서랍을 닫는다.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 서랍이 열려 있을 때 Esc 로 닫는다. 열면 첫 메뉴 항목으로 초점을 옮긴다(좁은 화면에서만 서랍이 된다).
  useEffect(() => {
    if (!open) return;
    document.getElementById(navId)?.querySelector<HTMLElement>('a[href]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, navId]);

  return (
    <div className="shell">
      <aside id={navId} className={open ? 'sidebar is-open' : 'sidebar'}>
        <div className="sidebar__brand">
          <Link href="/" className="brand">
            <span className="brand__mark" aria-hidden="true" />
            <span className="brand__name">{T.product}</span>
          </Link>
        </div>
        <SideNav me={me} can={can} unread={unread} />
      </aside>
      {open ? <div className="scrim is-open" aria-hidden="true" onClick={() => setOpen(false)} /> : null}
      <div className="shell__body">
        <TopBar
          me={me}
          companies={companies}
          companyError={companyError}
          onCompanyChanged={onCompanyChanged}
          menuButton={
            <button
              type="button"
              className="menu-toggle"
              aria-label={T.navLabel}
              aria-controls={navId}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <span className="menu-toggle__bar" aria-hidden="true" />
              <span className="menu-toggle__bar" aria-hidden="true" />
              <span className="menu-toggle__bar" aria-hidden="true" />
            </button>
          }
        />
        {children}
      </div>
    </div>
  );
}

function TopBar({
  me,
  companies,
  companyError,
  onCompanyChanged,
  menuButton,
}: {
  me: Me;
  companies: Company[];
  companyError: string;
  onCompanyChanged: () => Promise<void>;
  menuButton: ReactNode;
}) {
  const T = useT(TEXT);
  const selectId = useId();
  const userTypeLabel = useUserTypeLabel();
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
    <header className="topbar">
      {menuButton}
      {/* 좁은 화면에서만 보이는 제품 이름(넓은 화면은 사이드바 위에 있다) */}
      <Link href="/" className="brand topbar__brand">
        <span className="brand__mark" aria-hidden="true" />
        <span className="brand__name">{T.product}</span>
      </Link>

      <div className="topbar__company">
        {me.userType === 'SYSTEM_ADMIN' ? (
          <>
            <label htmlFor={selectId}>{T.actingCompany}</label>
            <select
              id={selectId}
              value={me.actingCompanyId ?? ''}
              disabled={busy}
              onChange={(e) => void selectCompany(e.target.value)}
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
            {T.companyOwn}: <span className="topbar__company-name">{me.company ? `${me.company.name} (${me.company.code})` : '-'}</span>
          </span>
        )}
      </div>
      {error || companyError ? (
        <span role="alert" className="topbar__error">{error || companyError}</span>
      ) : null}

      <div className="topbar__right">
        {/* 로그인한 사용자는 고른 언어를 계정에도 저장한다(결과는 기다리지 않고 화면은 바로 바뀐다). */}
        <LangSwitcher dark onChosen={saveUserLang} />
        <span className="user-chip">
          <span className="user-chip__avatar" aria-hidden="true">{initial(me.displayName)}</span>
          <span className="user-chip__text">
            <span className="user-chip__name">{me.displayName}</span>
            <span className="user-chip__meta">({me.loginId} · {userTypeLabel[me.userType] ?? me.userType})</span>
          </span>
        </span>
        {/* 로그인한 사용자가 스스로 비밀번호를 바꾸는 화면(주소를 직접 치지 않아도 되도록). 화면과 API 는 그대로다. */}
        <Link href="/change-password" className="btn btn--small btn--link" data-testid="change-password-link">
          {T.changePassword}
        </Link>
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

/** 고른 화면 언어를 계정에 저장한다. 실패해도 화면은 이미 바뀌었으므로 결과는 보지 않는다. */
function saveUserLang(lang: Lang): void {
  void api<{ saved: boolean }>('PATCH', '/api/me', { lang });
}

/** 사용자 표시의 첫 글자(장식용 아바타) */
function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '';
}

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
  const T = useT(TEXT);
  const pathname = usePathname();
  const main: NavItem[] = [{ href: '/', label: can('dashboard', 'read') ? T.navDashboard : T.navHome }];
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

  const history: NavItem[] = [];
  if (can('history.stock', 'read')) history.push({ href: '/history/stock', label: T.navStockHistory });
  if (can('history.audit', 'read')) history.push({ href: '/history/audit', label: T.navAudit });

  const admin: NavItem[] = [];
  if (can('admin.user', 'read')) admin.push({ href: '/admin/users', label: T.navUsers });
  if (can('admin.role', 'read')) admin.push({ href: '/admin/roles', label: T.navRoles });
  if (me.userType === 'SYSTEM_ADMIN') admin.push({ href: '/system/companies', label: T.navCompanies });

  const sections: NavSection[] = [
    { items: main },
    { title: T.navPeripheralGroup, items: peripheral },
    { title: T.navAlertGroup, items: alert },
    { title: T.navMailGroup, items: mail },
    { title: T.navHistoryGroup, items: history },
    { title: T.navMasterGroup, items: master },
    { title: T.navAdminGroup, items: admin },
  ].filter((sec) => sec.items.length > 0);

  return (
    <nav aria-label={T.navLabel} className="sidebar__nav">
      {sections.map((sec, i) => (
        <div key={sec.title ?? `section-${i}`} className="nav-section">
          {sec.title ? <div className="nav-heading">{sec.title}</div> : null}
          <ul className="nav-list" aria-label={sec.title}>
            {sec.items.map((it) => {
              const active = it.href === '/' || it.exact ? pathname === it.href : pathname === it.href || pathname.startsWith(it.href + '/');
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    aria-current={active ? 'page' : undefined}
                    className="nav-link"
                  >
                    {it.label}
                    {it.count ? (
                      <>
                        <span aria-hidden="true" className="nav-badge">
                          {T.unreadBadge(it.count)}
                        </span>
                        <span className="sr-only">{` (${T.unreadLabel(it.count)})`}</span>
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
  const T = useT(TEXT);
  const { me, effectiveCompanyId } = useShell();
  if (me.userType === 'SYSTEM_ADMIN' && !effectiveCompanyId) {
    return (
      <p className="notice">{T.pickCompany}</p>
    );
  }
  return <>{children}</>;
}
