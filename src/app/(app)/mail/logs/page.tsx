'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { RequireCompany } from '../../../shell';
import { api, Badge, EmptyRow, Notice, PageHeader, Table, td } from '../../../ui';
import { fmtDateTime } from '../../assets/shared';
import { Pager } from '../../peripherals/shared';
import { LOG_STATUS_LABEL, SENDING_DISABLED, type MailLogPage } from '../labels';

const PAGE_SIZE = 50;

const T = {
  title: '발송 기록',
  loading: '불러오는 중…',
  empty: '아직 발송된 메일이 없습니다.',
  colTime: '시각',
  colRecipient: '받는 사람',
  colSubject: '제목',
  colStatus: '상태',
  colError: '오류',
  none: '',
  total: (n: number) => `총 ${n.toLocaleString('ko-KR')}건`,
};

export default function MailLogsPage() {
  return (
    <RequireCompany>
      <Suspense fallback={<p style={{ color: '#6b7280' }}>{T.loading}</p>}>
        <LogsInner />
      </Suspense>
    </RequireCompany>
  );
}

function LogsInner() {
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
      {data === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <Table caption={T.total(data.total)} head={head}>
            {items.length === 0 ? (
              <EmptyRow colSpan={head.length}>
                {T.empty}
                <div style={{ fontSize: 13, marginTop: 4 }}>{SENDING_DISABLED}</div>
              </EmptyRow>
            ) : null}
            {items.map((l) => (
              <tr key={l.id}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}><time dateTime={l.sent_at}>{fmtDateTime(l.sent_at)}</time></td>
                <td style={td}>{l.recipient}</td>
                <td style={td}>{l.subject ?? T.none}</td>
                <td style={td}>
                  <Badge tone={l.status === 'SENT' ? 'green' : 'red'}>{LOG_STATUS_LABEL[l.status] ?? l.status}</Badge>
                </td>
                <td style={{ ...td, color: '#991b1b', fontSize: 13 }}>{l.error ?? T.none}</td>
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
