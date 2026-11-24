'use client';
import { useState, type FormEvent } from 'react';
import { useShell } from '../../shell';
import { api, Button, ErrorText, LabeledField, Modal, Notice, smallInput } from '../../ui';
import { PersonPicker, todayIso, type PersonRef } from '../assets/shared';
import { fmtQty, stockLabel } from './labels';
import { NoteField, parseQty, QtyField } from './shared';
import type { StockRow } from './types';

const T = {
  title: { ISSUE: '지급', LOAN: '대여' },
  intro: {
    ISSUE: '돌려받지 않는 지급입니다. 보유 수량에서 빠집니다.',
    LOAN: '돌려받을 대여입니다. 반납·분실은 대여 현황에서 처리합니다.',
  },
  available: (n: number) => `현재 보유 ${fmtQty(n)}개`,
  fPerson: '받는 직원',
  fQty: '수량',
  fDue: '반납 기한 (선택)',
  fLocation: '사용 위치 메모 (선택)',
  fNote: '메모 (선택)',
  personRequired: '받는 직원을 고르세요.',
  personUnavailable: '직원 명부를 볼 권한이 없어 받는 직원을 고를 수 없습니다.',
  done: { ISSUE: (n: number) => `지급했습니다. (남은 보유 ${fmtQty(n)}개)`, LOAN: (n: number) => `대여했습니다. (남은 보유 ${fmtQty(n)}개)` },
  cancel: '취소',
  processing: '처리 중…',
};

/**
 * 지급(ISSUE)·대여(LOAN). 수량 상한은 화면 안내용이고 서버가 잠금 뒤에 다시 검사한다.
 * 서버가 409(재고 부족 등)·404(범위 밖)로 거부하면 onConflict 로 부모가 메시지를 보여 주고 목록을 다시 불러온다.
 */
export function IssueDialog({
  stock,
  action,
  onClose,
  onDone,
  onConflict,
}: {
  stock: StockRow;
  action: 'ISSUE' | 'LOAN';
  onClose: () => void;
  onDone: (message: string) => void;
  onConflict: (message: string) => void;
}) {
  const { can } = useShell();
  const canPickPerson = can('master.person', 'read');
  const [person, setPerson] = useState<PersonRef | null>(null);
  const [qty, setQty] = useState('1');
  const [dueDate, setDueDate] = useState('');
  const [locationNote, setLocationNote] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!person) return setError(T.personRequired);
    const q = parseQty(qty, 1, stock.on_hand_qty);
    if ('error' in q) return setError(q.error);
    const body: Record<string, unknown> = { action, stockId: stock.id, personId: person.id, qty: q.qty };
    if (action === 'LOAN' && dueDate) body.dueDate = dueDate;
    if (locationNote.trim()) body.locationNote = locationNote.trim();
    if (note.trim()) body.note = note.trim();
    setBusy(true);
    const r = await api<{ onHandQty: number }>('POST', '/api/peripherals/issue', body);
    setBusy(false);
    if (r.ok) onDone(T.done[action](r.data.onHandQty));
    else if (r.redirected) return;
    else if (r.status === 409 || r.status === 404) onConflict(r.error.message);
    else setError(r.error.message);
  }

  return (
    <Modal title={`${T.title[action]} — ${stockLabel(stock)}`} onClose={onClose} width={480}>
      <p style={{ fontSize: 14, margin: '0 0 12px', color: '#374151' }}>
        {T.intro[action]} <strong>{T.available(stock.on_hand_qty)}</strong>
      </p>
      {canPickPerson ? (
        <form onSubmit={submit}>
          <LabeledField label={T.fPerson}>{(id) => <PersonPicker id={id} value={person} onChange={setPerson} activeOnly />}</LabeledField>
          <QtyField label={T.fQty} value={qty} onChange={setQty} min={1} max={stock.on_hand_qty} />
          {action === 'LOAN' ? (
            <LabeledField label={T.fDue}>
              {(id) => <input id={id} type="date" min={todayIso()} style={smallInput} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
            </LabeledField>
          ) : null}
          <LabeledField label={T.fLocation}>
            {(id) => <input id={id} style={smallInput} value={locationNote} onChange={(e) => setLocationNote(e.target.value)} maxLength={200} autoComplete="off" />}
          </LabeledField>
          <NoteField label={T.fNote} value={note} onChange={setNote} />
          <ErrorText>{error}</ErrorText>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
            <Button type="submit" variant="primary" disabled={busy}>{busy ? T.processing : T.title[action]}</Button>
          </div>
        </form>
      ) : (
        <Notice>{T.personUnavailable}</Notice>
      )}
    </Modal>
  );
}
