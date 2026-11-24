'use client';
import { useState, type FormEvent } from 'react';
import { api, Button, ErrorText, Modal } from '../../../ui';
import { fmtQty } from '../labels';
import { NoteField, parseQty, QtyField } from '../shared';
import type { LoanRow } from '../types';

const T = {
  title: { RETURN: '반납', LOAN_LOSS: '분실 처리' },
  summary: (person: string, model: string, n: number) => `${person} · ${model} · 미반납 ${fmtQty(n)}개`,
  returnIntro: '돌려받은 수량만큼 보유 수량에 다시 더합니다. 일부만 반납하면 대여는 미반납으로 남습니다.',
  lossWarn: '분실 처리한 수량은 재고로 돌아오지 않습니다. 대여 중 수량에서만 빠지고, 보유 수량은 그대로입니다. 되돌릴 수 없습니다.',
  fQty: { RETURN: '반납 수량', LOAN_LOSS: '분실 수량' },
  fNote: { RETURN: '메모 (선택)', LOAN_LOSS: '메모 (선택, 분실 경위 등)' },
  confirm: '분실 수량은 재고로 돌아오지 않는다는 것을 확인했습니다.',
  done: { RETURN: (n: number) => `반납했습니다. (남은 미반납 ${fmtQty(n)}개)`, LOAN_LOSS: (n: number) => `분실 처리했습니다. (남은 미반납 ${fmtQty(n)}개)` },
  cancel: '취소',
  processing: '처리 중…',
};

/** 대여의 반납(RETURN)·분실 처리(LOAN_LOSS). 수량은 미반납 수량 이하. */
export function LoanDialog({
  loan,
  action,
  onClose,
  onDone,
  onConflict,
}: {
  loan: LoanRow;
  action: 'RETURN' | 'LOAN_LOSS';
  onClose: () => void;
  onDone: (message: string) => void;
  onConflict: (message: string) => void;
}) {
  const [qty, setQty] = useState(String(loan.outstanding_qty));
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const loss = action === 'LOAN_LOSS';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const q = parseQty(qty, 1, loan.outstanding_qty);
    if ('error' in q) return setError(q.error);
    const body: Record<string, unknown> = { action, loanId: loan.id, qty: q.qty };
    if (note.trim()) body.note = note.trim();
    setBusy(true);
    const r = await api<unknown>('POST', '/api/peripherals/issue', body);
    setBusy(false);
    if (r.ok) onDone(T.done[action](loan.outstanding_qty - q.qty));
    else if (r.redirected) return;
    else if (r.status === 409 || r.status === 404) onConflict(r.error.message);
    else setError(r.error.message);
  }

  return (
    <Modal title={T.title[action]} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <p style={{ fontSize: 14, margin: '0 0 8px' }}>
          <strong>{T.summary(loan.person_name, `${loan.manufacturer} ${loan.model_name}`, loan.outstanding_qty)}</strong>
        </p>
        {loss ? (
          <div role="note" style={{ background: '#fdecec', color: '#991b1b', borderRadius: 6, padding: '10px 12px', fontSize: 14, marginBottom: 12, lineHeight: 1.5 }}>
            {T.lossWarn}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px' }}>{T.returnIntro}</p>
        )}
        <QtyField label={T.fQty[action]} value={qty} onChange={setQty} min={1} max={loan.outstanding_qty} />
        <NoteField label={T.fNote[action]} value={note} onChange={setNote} />
        {loss ? (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 12 }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {T.confirm}
          </label>
        ) : null}
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant={loss ? 'danger' : 'primary'} disabled={busy || (loss && !confirmed)}>{busy ? T.processing : T.title[action]}</Button>
        </div>
      </form>
    </Modal>
  );
}
