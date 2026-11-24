'use client';
import { useState, type FormEvent } from 'react';
import { api, Button, ErrorText, Modal } from '../../ui';
import { fmtQty, signed, stockLabel } from './labels';
import { NoteField, parseQty, QtyField } from './shared';
import { MAX_QTY, type StockRow } from './types';

const T = {
  title: { ADJUST: '실사 조정', DISPOSE: '폐기' },
  current: (n: number) => `현재 보유 수량: ${fmtQty(n)}개`,
  adjustIntro: '실제로 센 수량을 입력하면 보유 수량을 그 값으로 맞춥니다. 대여 중 수량은 바뀌지 않습니다.',
  fCounted: '실제로 센 수량',
  diff: (d: number, after: number) => `차이 ${signed(d)}개 → 조정 뒤 ${fmtQty(after)}개`,
  noChange: '현재 수량과 같습니다. 바꿀 것이 없습니다.',
  disposeWarn: '폐기한 수량은 보유 수량에서 빠지고 되돌릴 수 없습니다. 잘못 폐기했다면 실사 조정으로 다시 맞춰야 합니다.',
  fQty: '폐기 수량',
  fReason: '사유 (필수)',
  reasonRequired: '사유를 입력하세요.',
  confirm: '폐기하면 되돌릴 수 없다는 것을 확인했습니다.',
  done: { ADJUST: (n: number) => `조정했습니다. (현재 보유 ${fmtQty(n)}개)`, DISPOSE: (n: number) => `폐기했습니다. (남은 보유 ${fmtQty(n)}개)` },
  cancel: '취소',
  processing: '처리 중…',
};

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
