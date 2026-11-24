'use client';
import { useEffect, useState } from 'react';
import { api, EmptyRow, ErrorText, Modal, Table, td } from '../../ui';
import { stockLabel, usePeripheralLabels } from './labels';
import { Pager } from './shared';
import type { StockHistoryPage, StockRow } from './types';
import { useT } from '../../i18n';
import { TEXT } from './history-dialog.text';
import { useFmt } from '../../i18n/format';

const PAGE_SIZE = 20;

/** 재고 한 행의 이력(최신순). 서버가 전체 건수를 주지 않으므로, 한 쪽이 꽉 차면 다음 쪽이 있다고 본다. */
export function HistoryDialog({ stock, onClose }: { stock: StockRow; onClose: () => void }) {
  const F = useFmt();
  const L = usePeripheralLabels();
  const T = useT(TEXT);
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
      {data === null && !error ? <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{T.loading}</p> : null}
      {data ? (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>{T.qtyHint}</p>
          <Table head={head}>
            {rows.length === 0 ? <EmptyRow colSpan={head.length}>{T.empty}</EmptyRow> : null}
            {rows.map((h) => (
              <tr key={h.id}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}><time dateTime={h.created_at}>{F.dateTime(h.created_at)}</time></td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{L.txn[h.type] ?? h.type}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: h.qty < 0 ? 'var(--danger-text)' : 'var(--success-text)' }}>{F.signed(h.qty)}</td>
                <td style={td}>{h.person_name ?? ''}</td>
                <td style={td}>{h.actor_name ?? T.unknownActor}</td>
                <td style={td}>
                  {h.location_note ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{T.location(h.location_note)}</div> : null}
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
