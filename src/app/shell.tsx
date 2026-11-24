'use client';
// 로그인한 화면들이 함께 쓰는 틀: 상단 바(사용자·기업·로그아웃)와 왼쪽 메뉴.
// 메뉴와 버튼은 /api/me/permissions 로 그리지만 화면 편의일 뿐이다. 실제 판정은 각 API가 다시 한다.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { api, Button, ErrorText, USER_TYPE_LABEL, type UserType } from './ui';

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
  const permSet = new Set(perms.permissions);
  const can = (resource: string, operation: string) => perms.all || permSet.has(`${resource}:${operation}`);
  const value: ShellValue = {
    me,
    perms,
    can,
    effectiveCompanyId: me.companyId ?? me.actingCompanyId,
    companies,
    reloadCompanies: loadCompanies,
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
          <SideNav me={me} can={can} />
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

function SideNav({ me, can }: { me: Me; can: (resource: string, operation: string) => boolean }) {
  const pathname = usePathname();
  const items: { href: string; label: string }[] = [{ href: '/', label: T.navHome }];
  if (can('admin.user', 'read')) items.push({ href: '/admin/users', label: T.navUsers });
  if (can('admin.role', 'read')) items.push({ href: '/admin/roles', label: T.navRoles });
  if (me.userType === 'SYSTEM_ADMIN') items.push({ href: '/system/companies', label: T.navCompanies });

  return (
    <nav aria-label={T.navLabel} style={{ width: 180, flexShrink: 0, background: '#fff', borderRight: '1px solid #e2e5ea', padding: '14px 0' }}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((it) => {
          const active = it.href === '/' ? pathname === '/' : pathname === it.href || pathname.startsWith(it.href + '/');
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
              </Link>
            </li>
          );
        })}
      </ul>
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
