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
      <dl style={{ display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 6, fontSize: 14, background: '#fff', border: '1px solid #e2e5ea', borderRadius: 6, padding: '12px 14px' }}>
        <dt style={{ color: '#6b7280' }}>{T.type}</dt>
        <dd style={{ margin: 0 }}>{UTL[me.userType] ?? me.userType}</dd>
        {me.userType === 'SYSTEM_ADMIN' ? (
          <>
            <dt style={{ color: '#6b7280' }}>{T.actingCompany}</dt>
            <dd style={{ margin: 0 }}>{acting ? `${acting.name} (${acting.code})` : me.actingCompanyId ?? T.none}</dd>
          </>
        ) : (
          <>
            <dt style={{ color: '#6b7280' }}>{T.company}</dt>
            <dd style={{ margin: 0 }}>{me.company && me.companyId ? `${me.company.name} (${me.company.code})` : '-'}</dd>
          </>
        )}
      </dl>
      {me.userType === 'SYSTEM_ADMIN' ? <Notice>{me.actingCompanyId ? T.actingNote : T.pickCompany}</Notice> : <p style={{ fontSize: 13, color: '#4b5563' }}>{T.menuHint}</p>}
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
        <h1 style={{ fontSize: 20, margin: 0 }}>{T.dashTitle}</h1>
        {data ? <span style={{ fontSize: 13, color: '#6b7280' }}>{T.asOf(data.today)}</span> : null}
      </div>
      <ErrorText>{error}</ErrorText>
      {data === null && !error ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {data ? (
        <>
          {data.scoped ? <Notice>{T.scoped}</Notice> : null}
          {sections === 0 ? <Notice>{T.noSections}</Notice> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 14 }}>
            {data.assets ? (
              <Card title={T.assets} testId="dash-assets">
                <Big label={T.assetsTotal} value={F.num(data.assets.total)} />
                <div style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 4px' }}>{T.byState}</div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {data.assets.byState.map((s) => (
                    <li key={`${s.state}:${s.substate ?? ''}`} style={{ fontSize: 13, background: '#f5f6f8', borderRadius: 10, padding: '2px 8px' }}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 5, background: TONE_DOT[STATE_TONE[s.state as AssetState] ?? 'gray'] }} aria-hidden />
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
              <Card title={T.peripherals} testId="dash-peripherals">
                <Rows>
                  <Row label={T.onHand} value={F.num(data.peripherals.onHand)} href="/peripherals" link={link} resource="peripheral.stock" />
                  <Row label={T.onLoan} value={F.num(data.peripherals.onLoan)} />
                </Rows>
              </Card>
            ) : null}
            {data.loans ? (
              <Card title={T.loans} testId="dash-loans">
                <Rows>
                  <Row label={T.openLoans} value={F.num(data.loans.open)} href="/peripherals/loans" link={link} resource="peripheral.loan" />
                  <Row label={T.overdueLoans} value={F.num(data.loans.overdue)} alert={data.loans.overdue > 0} href="/peripherals/loans?overdue=true" link={link} resource="peripheral.loan" />
                </Rows>
              </Card>
            ) : null}
            {data.thresholds ? (
              <Card title={T.thresholds} testId="dash-thresholds">
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

const TONE_DOT: Record<string, string> = { green: '#16a34a', gray: '#9ca3af', red: '#dc2626', amber: '#d97706', blue: '#2563eb' };

function Card({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section aria-label={title} data-testid={testId} style={{ background: '#fff', border: '1px solid #e2e5ea', borderRadius: 8, padding: '14px 16px' }}>
      <h2 style={{ fontSize: 15, margin: '0 0 8px', color: '#374151' }}>{title}</h2>
      {children}
    </section>
  );
}

function Big({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div>
      <div data-testid="big-value" style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <dl style={{ margin: '10px 0 0', display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 6, fontSize: 14 }}>{children}</dl>;
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
  const text = <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: alert ? '#b91c1c' : undefined }}>{value}</span>;
  return (
    <div style={{ display: 'contents' }}>
      <dt style={{ color: '#4b5563' }}>{label}</dt>
      <dd style={{ margin: 0, textAlign: 'right' }}>{href && link && resource ? link(href, resource, text) : text}</dd>
    </div>
  );
}

function CategoryBars({ rows }: { rows: { id: string; name: string; available: number; in_use: number; total: number }[] }) {
  const F = useFmt();
  const T = useT(TEXT);
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <section aria-label={T.byCategory} data-testid="dash-categories" style={{ background: '#fff', border: '1px solid #e2e5ea', borderRadius: 8, padding: '14px 16px', marginTop: 14 }}>
      <h2 style={{ fontSize: 15, margin: '0 0 2px', color: '#374151' }}>{T.byCategory}</h2>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>{T.byCategoryHint}</p>
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: '#4b5563', marginBottom: 8 }} aria-hidden>
        <span><Swatch color="#16a34a" /> {T.available}</span>
        <span><Swatch color="#2563eb" /> {T.inUse}</span>
        <span><Swatch color="#d1d5db" /> {T.total}</span>
      </div>
      {rows.length === 0 ? <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>{T.noCategory}</p> : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {rows.map((r) => (
          <li key={r.id} aria-label={T.barLabel(r.name, F.num(r.available), F.num(r.in_use), F.num(r.total))} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 150px', gap: 10, alignItems: 'center', fontSize: 13 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name}>{r.name}</span>
            <div style={{ background: '#f0f2f5', borderRadius: 4, height: 14 }} aria-hidden>
              <div style={{ width: `${(r.total / max) * 100}%`, height: '100%', background: '#d1d5db', borderRadius: 4, display: 'flex', overflow: 'hidden' }}>
                <div style={{ width: `${r.total ? (r.available / r.total) * 100 : 0}%`, background: '#16a34a' }} />
                <div style={{ width: `${r.total ? (r.in_use / r.total) * 100 : 0}%`, background: '#2563eb' }} />
              </div>
            </div>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: '#374151', textAlign: 'right' }}>
              {`${F.num(r.available)} / ${F.num(r.in_use)} / ${F.num(r.total)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Swatch({ color }: { color: string }) {
  return <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color, verticalAlign: 'middle' }} />;
}
