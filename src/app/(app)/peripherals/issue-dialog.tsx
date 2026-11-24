'use client';
import { useState, type FormEvent } from 'react';
import { useShell } from '../../shell';
import { api, Button, ErrorText, LabeledField, Modal, Notice, smallInput } from '../../ui';
import { PersonPicker, todayIso, type PersonRef } from '../assets/shared';
import { stockLabel } from './labels';
import { NoteField, useParseQty, QtyField } from './shared';
import type { StockRow } from './types';
import { useT } from '../../i18n';
import { TEXT } from './issue-dialog.text';

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
  const T = useT(TEXT);
  const parseQty = useParseQty();
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
      <p style={{ fontSize: 14, margin: '0 0 12px', color: 'var(--text-secondary)' }}>
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
