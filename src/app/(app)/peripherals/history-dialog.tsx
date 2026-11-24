'use client';
import { useEffect, useState } from 'react';
import { api, EmptyRow, ErrorText, Modal, Table, td } from '../../ui';
import { fmtDateTime } from '../assets/shared';
import { signed, stockLabel, TXN_LABEL } from './labels';
import { Pager } from './shared';
import type { StockHistoryPage, StockRow } from './types';

const PAGE_SIZE = 20;

const T = {
  title: (name: string) => `이력 — ${name}`,
  loading: '불러오는 중…',
  empty: '이력이 없습니다.',
  colTime: '일시',
  colType: '종류',
  colQty: '수량',
  colPerson: '직원',
  colActor: '처리자',
  colNote: '메모',
  location: (s: string) => `위치: ${s}`,
  unknownActor: '알 수 없음',
  qtyHint: '수량은 보유 수량이 늘면 +, 줄면 - 입니다. 대여 분실은 대여 중 수량이 줄어든 것이라 - 로 표시합니다.',
};

/** 재고 한 행의 이력(최신순). 서버가 전체 건수를 주지 않으므로, 한 쪽이 꽉 차면 다음 쪽이 있다고 본다. */
export function HistoryDialog({ stock, onClose }: { stock: StockRow; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<StockHistoryPage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void (async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      const r = await api<StockHistoryPage>('GET', `/api/peripherals/${encodeURIComponent(stock.id)}/history?${params.toString()}`);
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setError('');
      } else if (!r.redirected) setError(r.error.message);
    })();
    return () => {
      live = false;
    };
  }, [stock.id, page]);

  const rows = data?.history ?? [];
  const head = [T.colTime, T.colType, T.colQty, T.colPerson, T.colActor, T.colNote];
  return (
    <Modal title={T.title(stockLabel(stock))} onClose={onClose} width={820}>
      <ErrorText>{error}</ErrorText>
      {data === null && !error ? <p style={{ color: '#6b7280', fontSize: 14 }}>{T.loading}</p> : null}
      {data ? (
        <>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>{T.qtyHint}</p>
          <Table head={head}>
            {rows.length === 0 ? <EmptyRow colSpan={head.length}>{T.empty}</EmptyRow> : null}
            {rows.map((h) => (
              <tr key={h.id}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}><time dateTime={h.created_at}>{fmtDateTime(h.created_at)}</time></td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{TXN_LABEL[h.type] ?? h.type}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: h.qty < 0 ? '#b91c1c' : '#166534' }}>{signed(h.qty)}</td>
                <td style={td}>{h.person_name ?? ''}</td>
                <td style={td}>{h.actor_name ?? T.unknownActor}</td>
                <td style={td}>
                  {h.location_note ? <div style={{ color: '#6b7280', fontSize: 13 }}>{T.location(h.location_note)}</div> : null}
                  {h.note ?? ''}
                </td>
              </tr>
            ))}
          </Table>
          <Pager page={data.page} pageSize={data.pageSize} hasNext={rows.length === data.pageSize} onPage={setPage} />
        </>
      ) : null}
    </Modal>
  );
}
