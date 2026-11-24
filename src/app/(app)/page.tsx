'use client';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useShell } from '../shell';
import { api, ErrorText, Notice, useUserTypeLabel } from '../ui';
import { STATE_TONE, stateText, useAssetLabels } from './assets/labels';
import type { AssetState } from '@/lib/assets/transitions';
import { useT } from '../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../i18n/format';

interface DashboardData {
  today: string;
  scoped: boolean;
  assets: {
    total: number;
    byState: { state: string; substate: string | null; n: number }[];
    byCategory: { id: string; name: string; available: number; in_use: number; total: number }[];
    overdue: number;
    warrantySoon: number;
  } | null;
  peripherals: { onHand: number; onLoan: number; stockRows: number } | null;
  loans: { open: number; overdue: number } | null;
  thresholds: { active: number; low: number } | null;
}

export default function HomePage() {
  const { can, effectiveCompanyId } = useShell();
  if (effectiveCompanyId && can('dashboard', 'read')) return <Dashboard />;
  return <Welcome />;
}

/** 대시보드 권한이 없거나 기업을 고르지 않은 경우의 첫 화면 */
function Welcome() {
  const UTL = useUserTypeLabel();
  const T = useT(TEXT);
  const { me, companies } = useShell();
  const acting = me.actingCompanyId ? companies.find((c) => c.id === me.actingCompanyId) : undefined;
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 20, marginTop: 0 }}>{T.title}</h1>
      <p>{T.welcome(me.displayName)}</p>
      <dl className="panel" style={{ display: 'grid', gridTemplateColumns: 'minmax(100px, 140px) 1fr', rowGap: 6, columnGap: 8, fontSize: 14, padding: '14px 16px' }}>
        <dt>{T.type}</dt>
        <dd style={{ margin: 0 }}>{UTL[me.userType] ?? me.userType}</dd>
        {me.userType === 'SYSTEM_ADMIN' ? (
          <>
            <dt>{T.actingCompany}</dt>
            <dd style={{ margin: 0 }}>{acting ? `${acting.name} (${acting.code})` : me.actingCompanyId ?? T.none}</dd>
          </>
        ) : (
          <>
            <dt>{T.company}</dt>
            <dd style={{ margin: 0 }}>{me.company && me.companyId ? `${me.company.name} (${me.company.code})` : '-'}</dd>
          </>
        )}
      </dl>
      {me.userType === 'SYSTEM_ADMIN' ? <Notice>{me.actingCompanyId ? T.actingNote : T.pickCompany}</Notice> : <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{T.menuHint}</p>}
    </div>
  );
}

function Dashboard() {
  const AL = useAssetLabels();
  const F = useFmt();
  const T = useT(TEXT);
  const { can } = useShell();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await api<DashboardData>('GET', '/api/dashboard');
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setError('');
      } else if (!r.redirected) setError(r.error.message);
    })();
    return () => {
      live = false;
    };
  }, []);

  const link = (href: string, resource: string, children: ReactNode) => (can(resource, 'read') ? <Link href={href}>{children}</Link> : children);

  const sections = data ? [data.assets, data.peripherals, data.loans, data.thresholds].filter((s) => s !== null).length : 0;

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h1 className="page-header__title">{T.dashTitle}</h1>
        {data ? <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{T.asOf(data.today)}</span> : null}
      </div>
      <ErrorText>{error}</ErrorText>
      {data === null && !error ? <p style={{ color: 'var(--text-muted)' }}>{T.loading}</p> : null}
      {data ? (
        <>
          {data.scoped ? <Notice>{T.scoped}</Notice> : null}
          {sections === 0 ? <Notice>{T.noSections}</Notice> : null}
          <div className="stat-grid">
            {data.assets ? (
              <Card title={T.assets} testId="dash-assets" tone="blue">
                <Big label={T.assetsTotal} value={F.num(data.assets.total)} />
                <div className="stat-card__label" style={{ margin: '10px 0 6px' }}>{T.byState}</div>
                <ul className="state-chips">
                  {data.assets.byState.map((s) => (
                    <li key={`${s.state}:${s.substate ?? ''}`} className="state-chip">
                      <span className={`dot dot--${STATE_TONE[s.state as AssetState] ?? 'gray'}`} aria-hidden />
                      {stateText(AL, s.state, s.substate)} <strong>{F.num(s.n)}</strong>
                    </li>
                  ))}
                </ul>
                <Rows>
                  <Row label={T.overdue} value={F.num(data.assets.overdue)} alert={data.assets.overdue > 0} href={data.assets.overdue > 0 ? '/assets?overdue=true' : undefined} link={link} resource="asset.item" />
                  <Row label={T.warrantySoon} value={F.num(data.assets.warrantySoon)} alert={data.assets.warrantySoon > 0} />
                </Rows>
              </Card>
            ) : null}
            {data.peripherals ? (
              <Card title={T.peripherals} testId="dash-peripherals" tone="green">
                <Rows>
                  <Row label={T.onHand} value={F.num(data.peripherals.onHand)} href="/peripherals" link={link} resource="peripheral.stock" />
                  <Row label={T.onLoan} value={F.num(data.peripherals.onLoan)} />
                </Rows>
              </Card>
            ) : null}
            {data.loans ? (
              <Card title={T.loans} testId="dash-loans" tone="purple">
                <Rows>
                  <Row label={T.openLoans} value={F.num(data.loans.open)} href="/peripherals/loans" link={link} resource="peripheral.loan" />
                  <Row label={T.overdueLoans} value={F.num(data.loans.overdue)} alert={data.loans.overdue > 0} href="/peripherals/loans?overdue=true" link={link} resource="peripheral.loan" />
                </Rows>
              </Card>
            ) : null}
            {data.thresholds ? (
              <Card title={T.thresholds} testId="dash-thresholds" tone="amber">
                <Rows>
                  <Row label={T.activeThresholds} value={F.num(data.thresholds.active)} />
                  <Row label={T.lowThresholds} value={F.num(data.thresholds.low)} alert={data.thresholds.low > 0} href="/thresholds" link={link} resource="threshold" />
                </Rows>
              </Card>
            ) : null}
          </div>
          {data.assets ? <CategoryBars rows={data.assets.byCategory} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** 통계 카드(기존 제품의 KPI 카드 모양). tone 은 위쪽 띠의 색이다. */
function Card({ title, testId, tone, children }: { title: string; testId: string; tone: 'blue' | 'green' | 'purple' | 'amber'; children: ReactNode }) {
  return (
    <section aria-label={title} data-testid={testId} className={`stat-card stat-card--${tone}`}>
      <h2 className="stat-card__title">{title}</h2>
      {children}
    </section>
  );
}

function Big({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="stat-card__label">{label}</div>
      <div data-testid="big-value" className="stat-card__value">{value}</div>
    </div>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="stat-rows">{children}</dl>;
}

function Row({
  label,
  value,
  alert,
  href,
  link,
  resource,
}: {
  label: string;
  value: string;
  alert?: boolean;
  href?: string;
  link?: (href: string, resource: string, children: ReactNode) => ReactNode;
  resource?: string;
}) {
  const text = <span className={alert ? 'stat-num stat-num--alert' : 'stat-num'}>{value}</span>;
  return (
    <div style={{ display: 'contents' }}>
      <dt>{label}</dt>
      <dd>{href && link && resource ? link(href, resource, text) : text}</dd>
    </div>
  );
}

function CategoryBars({ rows }: { rows: { id: string; name: string; available: number; in_use: number; total: number }[] }) {
  const F = useFmt();
  const T = useT(TEXT);
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <section aria-label={T.byCategory} data-testid="dash-categories" className="stat-card stat-card--blue" style={{ marginTop: 16 }}>
      <h2 className="stat-card__title" style={{ margin: '0 0 2px' }}>{T.byCategory}</h2>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>{T.byCategoryHint}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }} aria-hidden>
        <span><Swatch kind="available" /> {T.available}</span>
        <span><Swatch kind="in-use" /> {T.inUse}</span>
        <span><Swatch kind="total" /> {T.total}</span>
      </div>
      {rows.length === 0 ? <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>{T.noCategory}</p> : null}
      <ul className="bar-list">
        {rows.map((r) => (
          <li key={r.id} aria-label={T.barLabel(r.name, F.num(r.available), F.num(r.in_use), F.num(r.total))} className="bar-row">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name}>{r.name}</span>
            <div className="bar-track" aria-hidden>
              <div className="bar-fill" style={{ width: `${(r.total / max) * 100}%` }}>
                <div className="bar-seg--available" style={{ width: `${r.total ? (r.available / r.total) * 100 : 0}%` }} />
                <div className="bar-seg--in-use" style={{ width: `${r.total ? (r.in_use / r.total) * 100 : 0}%` }} />
              </div>
            </div>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)', textAlign: 'right' }}>
              {`${F.num(r.available)} / ${F.num(r.in_use)} / ${F.num(r.total)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Swatch({ kind }: { kind: 'available' | 'in-use' | 'total' }) {
  return <span className={`swatch swatch--${kind}`} />;
}
