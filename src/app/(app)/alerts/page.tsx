'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { RequireCompany, useShell } from '../../shell';
import { api, Badge, Button, ErrorText, PageHeader } from '../../ui';
import { Pager } from '../peripherals/shared';
import { ALERT_TYPE_TONE, describeAlert, isKnownType, useAlertLabels, type AlertItem, type AlertPage } from './labels';
import { useT } from '../../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../../i18n/format';

const PAGE_SIZE = 30;

export default function AlertsPage() {
  const T = useT(TEXT);
  return (
    <RequireCompany>
      {/* useSearchParams 는 Suspense 경계 안에서 써야 한다(Next.js 빌드 규칙). */}
      <Suspense fallback={<p style={{ color: 'var(--text-muted)' }}>{T.loading}</p>}>
        <AlertsInner />
      </Suspense>
    </RequireCompany>
  );
}

function AlertsInner() {
  const T = useT(TEXT);
  const { syncUnread } = useShell();
  const router = useRouter();
  const sp = useSearchParams();
  const spKey = sp.toString();
  const unreadOnly = sp.get('unreadOnly') === 'true';

  const [data, setData] = useState<AlertPage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  function setParams(patch: Record<string, string | null>, keepPage = false) {
    const next = new URLSearchParams(spKey);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!keepPage) next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `/alerts?${qs}` : '/alerts', { scroll: false });
  }

  useEffect(() => {
    const from = new URLSearchParams(spKey);
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (from.get('unreadOnly') === 'true') params.set('unreadOnly', 'true');
    const page = from.get('page');
    if (page) params.set('page', page);
    let live = true;
    void (async () => {
      const r = await api<AlertPage>('GET', `/api/alerts?${params.toString()}`);
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setLoadError('');
        // 읽음 처리 뒤 다시 불러온 건수, 새로 생긴 날짜 기준 알림이 메뉴의 표시에도 반영되게 한다.
        syncUnread(r.data.unread);
      } else if (!r.redirected) {
        setData(null);
        setLoadError(r.error.message);
      }
    })();
    return () => {
      live = false;
    };
  }, [spKey, reload]);

  async function markRead(body: { ids: string[] } | { all: true }) {
    setBusy(true);
    setNotice('');
    setActionError('');
    const r = await api<{ updated: number }>('POST', '/api/alerts/read', body);
    setBusy(false);
    if (r.ok) {
      if ('all' in body) setNotice(T.markedAll(r.data.updated));
      setReload((n) => n + 1);
    } else if (!r.redirected) setActionError(r.error.message);
  }

  const items = data?.items ?? [];

  return (
    <div style={{ maxWidth: 900 }}>
      <PageHeader
        title={T.title}
        actions={data && data.unread > 0 ? <Button disabled={busy} onClick={() => void markRead({ all: true })}>{T.markAll}</Button> : null}
      />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 10, fontSize: 14 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setParams({ unreadOnly: e.target.checked ? 'true' : null })} />
          {T.unreadOnly}
        </label>
        {data ? <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{T.summary(data.total, data.unread)}</span> : null}
      </div>

      {notice ? <p role="status" style={{ color: 'var(--success-text)', fontSize: 14 }}>{notice}</p> : null}
      <ErrorText>{actionError || loadError}</ErrorText>
      {data === null && !loadError ? <p style={{ color: 'var(--text-muted)' }}>{T.loading}</p> : null}
      {data ? (
        <>
          {items.length === 0 ? (
            <p style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
              {unreadOnly ? T.emptyUnread : T.empty}
            </p>
          ) : (
            <ul aria-label={T.listLabel} style={{ listStyle: 'none', margin: 0, padding: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }}>
              {items.map((a, i) => (
                <AlertRow key={a.id} alert={a} first={i === 0} busy={busy} onRead={() => void markRead({ ids: [a.id] })} />
              ))}
            </ul>
          )}
          <Pager page={data.page} total={data.total} pageSize={data.pageSize} onPage={(p) => setParams({ page: String(p) }, true)} />
        </>
      ) : null}
    </div>
  );
}

function AlertRow({ alert, first, busy, onRead }: { alert: AlertItem; first: boolean; busy: boolean; onRead: () => void }) {
  const F = useFmt();
  const AL = useAlertLabels();
  const T = useT(TEXT);
  const { can } = useShell();
  const unread = alert.read_at === null;
  const view = describeAlert(AL, F.locale, alert.type, alert.payload);
  const link = view.link && can(...view.link.permission) ? view.link.href : null;
  return (
    <li
      style={{
        display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 14px', borderTop: first ? 0 : '1px solid var(--border-subtle)',
        background: unread ? 'var(--accent-bg)' : 'var(--surface)', borderLeft: unread ? '3px solid var(--accent-blue)' : '3px solid transparent',
      }}
    >
      <div style={{ flex: 1, minWidth: 0, fontSize: 14 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 2 }}>
          {isKnownType(alert.type) ? <Badge tone={ALERT_TYPE_TONE[alert.type]}>{AL.type[alert.type]}</Badge> : <Badge tone="gray">{alert.type}</Badge>}
          {unread ? <span style={{ fontSize: 12, color: 'var(--accent-text)', fontWeight: 600 }}>{T.unreadMark}</span> : null}
          <time dateTime={alert.created_at} style={{ fontSize: 12, color: 'var(--text-muted)' }}>{F.dateTime(alert.created_at)}</time>
        </div>
        {view.text ? <div style={{ fontWeight: unread ? 600 : undefined }}>{view.text}</div> : null}
        {link ? <Link href={link} style={{ fontSize: 13 }}>{T.open}</Link> : null}
      </div>
      {unread ? <Button small disabled={busy} onClick={onRead}>{T.markRead}</Button> : null}
    </li>
  );
}
