'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { RequireCompany } from '../../../shell';
import { api, Badge, EmptyRow, Notice, PageHeader, Table, td } from '../../../ui';
import { Pager } from '../../peripherals/shared';
import { useMailLabels, type MailLogPage } from '../labels';
import { useT } from '../../../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../../../i18n/format';

const PAGE_SIZE = 50;

export default function MailLogsPage() {
  const T = useT(TEXT);
  return (
    <RequireCompany>
      <Suspense fallback={<p style={{ color: 'var(--text-muted)' }}>{T.loading}</p>}>
        <LogsInner />
      </Suspense>
    </RequireCompany>
  );
}

function LogsInner() {
  const F = useFmt();
  const M = useMailLabels();
  const T = useT(TEXT);
  const router = useRouter();
  const sp = useSearchParams();
  const page = sp.get('page') ?? '';
  const [data, setData] = useState<MailLogPage | null>(null);
  // 부서 범위가 제한된 사용자는 서버가 403 과 이유를 준다(받는 사람 주소가 들어 있으므로). 그 문구를 그대로 보여 준다.
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (page) params.set('page', page);
    let live = true;
    void (async () => {
      const r = await api<MailLogPage>('GET', `/api/mail/logs?${params.toString()}`);
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setLoadError('');
      } else if (!r.redirected) {
        setData(null);
        setLoadError(r.error.message);
      }
    })();
    return () => {
      live = false;
    };
  }, [page]);

  const head = [T.colTime, T.colRecipient, T.colSubject, T.colStatus, T.colError];
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader title={T.title} />
      {loadError ? <Notice>{loadError}</Notice> : null}
      {data === null && !loadError ? <p style={{ color: 'var(--text-muted)' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <Table caption={T.total(data.total)} head={head}>
            {items.length === 0 ? (
              <EmptyRow colSpan={head.length}>
                {T.empty}
                <div style={{ fontSize: 13, marginTop: 4 }}>{M.sendingDisabled}</div>
              </EmptyRow>
            ) : null}
            {items.map((l) => (
              <tr key={l.id}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}><time dateTime={l.sent_at}>{F.dateTime(l.sent_at)}</time></td>
                <td style={td}>{l.recipient}</td>
                <td style={td}>{l.subject ?? T.none}</td>
                <td style={td}>
                  <Badge tone={l.status === 'SENT' ? 'green' : 'red'}>{M.logStatus[l.status] ?? l.status}</Badge>
                </td>
                <td style={{ ...td, color: 'var(--danger-text)', fontSize: 13 }}>{l.error ?? T.none}</td>
              </tr>
            ))}
          </Table>
          <Pager
            page={data.page}
            total={data.total}
            pageSize={data.pageSize}
            onPage={(p) => router.replace(p > 1 ? `/mail/logs?page=${p}` : '/mail/logs', { scroll: false })}
          />
        </>
      ) : null}
    </div>
  );
}
