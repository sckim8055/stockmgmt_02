'use client';
import { useState, type FormEvent } from 'react';
import { api, Button, ErrorText, Modal } from '../../ui';
import { stockLabel } from './labels';
import { NoteField, useParseQty, QtyField } from './shared';
import { MAX_QTY, type StockRow } from './types';
import { useT } from '../../i18n';
import { TEXT } from './adjust-dialog.text';

/** 실사 조정(ADJUST)·폐기(DISPOSE). 둘 다 사유가 필수다. */
export function AdjustDialog({
  stock,
  action,
  onClose,
  onDone,
  onConflict,
}: {
  stock: StockRow;
  action: 'ADJUST' | 'DISPOSE';
  onClose: () => void;
  onDone: (message: string) => void;
  onConflict: (message: string) => void;
}) {
  const T = useT(TEXT);
  const parseQty = useParseQty();
  const [qty, setQty] = useState(action === 'ADJUST' ? String(stock.on_hand_qty) : '1');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dispose = action === 'DISPOSE';

  const parsed = dispose ? parseQty(qty, 1, stock.on_hand_qty) : parseQty(qty, 0, MAX_QTY);
  const delta = 'qty' in parsed && !dispose ? parsed.qty - stock.on_hand_qty : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if ('error' in parsed) return setError(parsed.error);
    if (delta === 0) return setError(T.noChange);
    if (!note.trim()) return setError(T.reasonRequired);
    const body = dispose
      ? { action, stockId: stock.id, qty: parsed.qty, note: note.trim() }
      : { action, stockId: stock.id, countedQty: parsed.qty, note: note.trim() };
    setBusy(true);
    const r = await api<{ onHandQty: number }>('POST', '/api/peripherals/adjust', body);
    setBusy(false);
    if (r.ok) onDone(T.done[action](r.data.onHandQty));
    else if (r.redirected) return;
    else if (r.status === 409 || r.status === 404) onConflict(r.error.message);
    else setError(r.error.message);
  }

  return (
    <Modal title={`${T.title[action]} — ${stockLabel(stock)}`} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <p style={{ fontSize: 14, margin: '0 0 8px' }}><strong>{T.current(stock.on_hand_qty)}</strong></p>
        {dispose ? (
          <div role="note" style={{ background: '#fdecec', color: '#991b1b', borderRadius: 6, padding: '10px 12px', fontSize: 14, marginBottom: 12, lineHeight: 1.5 }}>
            {T.disposeWarn}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px' }}>{T.adjustIntro}</p>
        )}
        <QtyField label={dispose ? T.fQty : T.fCounted} value={qty} onChange={setQty} min={dispose ? 1 : 0} max={dispose ? stock.on_hand_qty : undefined} />
        {delta !== null ? (
          <p role="status" style={{ fontSize: 14, margin: '-4px 0 12px', color: delta === 0 ? '#6b7280' : delta > 0 ? '#166534' : '#b91c1c' }}>
            {delta === 0 ? T.noChange : T.diff(delta, stock.on_hand_qty + delta)}
          </p>
        ) : null}
        <NoteField label={T.fReason} value={note} onChange={setNote} required />
        {dispose ? (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 12 }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {T.confirm}
          </label>
        ) : null}
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant={dispose ? 'danger' : 'primary'} disabled={busy || delta === 0 || (dispose && !confirmed)}>
            {busy ? T.processing : T.title[action]}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
