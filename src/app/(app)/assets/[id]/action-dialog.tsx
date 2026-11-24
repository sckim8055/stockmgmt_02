'use client';
import { useState, type FormEvent } from 'react';
import type { AssetAction } from '@/lib/assets/transitions';
import { api, Button, ErrorText, LabeledField, Modal, smallInput } from '../../../ui';
import { actionUrl, DESTRUCTIVE } from '../actions';
import { ACTION_LABEL, DISPOSAL_LABEL } from '../labels';
import { PersonPicker, todayIso, type PersonRef } from '../shared';
import type { AssetRow } from '../types';

const T = {
  title: (action: string, tag: string) => `${action} — ${tag}`,
  fPerson: '받는 직원',
  fDue: '반납 기한',
  fDefective: '불량 상태로 반납 (사용할 수 없는 재고로 둡니다)',
  fDisposal: '처분 방식',
  fLocation: '위치',
  fLocationHint: '바꾸지 않으면 현재 위치를 그대로 둡니다. 비우면 위치를 지웁니다.',
  fNote: '메모 (선택)',
  personRequired: '받는 직원을 고르세요.',
  dueRequired: '반납 기한을 입력하세요.',
  disposalRequired: '처분 방식을 고르세요.',
  confirm: '이 처리는 되돌리기 어렵다는 것을 확인했습니다.',
  warn: {
    RETIRE: '자산을 퇴역(폐기 대기) 상태로 바꿉니다. 퇴역한 자산은 다시 배정할 수 없고, 처분만 할 수 있습니다.',
    DISPOSE: '자산을 처분 완료로 기록합니다. 처분된 자산은 더 이상 어떤 처리도 할 수 없습니다.',
    VOID: '잘못 등록한 자산을 등록 취소합니다. 등록 취소된 자산은 수정할 수 없고 기본 목록에서 빠지며, 자산 태그도 다시 쓸 수 없습니다.',
    MARK_MISSING: '자산을 분실 상태로 바꿉니다. 마지막 보유자 정보는 남겨 둡니다.',
  } as Partial<Record<AssetAction, string>>,
  cancel: '취소',
  processing: '처리 중…',
};

const NEEDS_PERSON: ReadonlySet<AssetAction> = new Set<AssetAction>(['ASSIGN', 'LOAN']);
// 자산이 실제로 옮겨지는 처리에서만 위치를 함께 받는다.
const TAKES_LOCATION: ReadonlySet<AssetAction> = new Set<AssetAction>(['ASSIGN', 'LOAN', 'RETURN', 'RECEIVE', 'FOUND', 'REPAIR_OUT']);

/**
 * 처리 대화상자. 처리마다 필요한 입력만 받는다(src/lib/assets/transitions.ts 의 ActionInput).
 * onConflict: 서버가 409(상태가 그사이 바뀜 등)나 404 를 답하면 부모가 메시지를 보여 주고 자산을 다시 불러온다.
 */
export function ActionDialog({
  asset,
  action,
  onClose,
  onDone,
  onConflict,
}: {
  asset: AssetRow;
  action: AssetAction;
  onClose: () => void;
  onDone: () => void;
  onConflict: (message: string) => void;
}) {
  const [person, setPerson] = useState<PersonRef | null>(null);
  const [dueDate, setDueDate] = useState('');
  const [defective, setDefective] = useState(false);
  const [disposal, setDisposal] = useState<'' | 'DISPOSED' | 'SOLD' | 'DONATED'>('');
  const [location, setLocation] = useState(asset.location ?? '');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const destructive = DESTRUCTIVE.has(action);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const body: Record<string, unknown> = { action };
    if (NEEDS_PERSON.has(action)) {
      if (!person) return setError(T.personRequired);
      body.holderPersonId = person.id;
    }
    if (action === 'LOAN') {
      if (!dueDate) return setError(T.dueRequired);
      body.dueDate = dueDate;
    }
    if (action === 'RETURN') body.defective = defective;
    if (action === 'DISPOSE') {
      if (!disposal) return setError(T.disposalRequired);
      body.disposal = disposal;
    }
    // 위치는 바꿨을 때만 보낸다(빠지면 서버가 그대로 둔다).
    if (TAKES_LOCATION.has(action) && location.trim() !== (asset.location ?? '')) body.location = location.trim() || null;
    if (note.trim()) body.note = note.trim();

    setBusy(true);
    const r = await api<{ state: string; substate: string | null }>('POST', actionUrl(asset.id, action), body);
    setBusy(false);
    if (r.ok) onDone();
    else if (r.redirected) return;
    else if (r.status === 409 || r.status === 404) onConflict(r.error.message);
    else setError(r.error.message);
  }

  const label = ACTION_LABEL[action];
  const warn = T.warn[action];
  return (
    <Modal title={T.title(label, asset.asset_tag)} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        {warn ? (
          <div role="note" style={{ background: '#fdecec', color: '#991b1b', borderRadius: 6, padding: '10px 12px', fontSize: 14, marginBottom: 12, lineHeight: 1.5 }}>
            {warn}
          </div>
        ) : null}
        {NEEDS_PERSON.has(action) ? (
          <LabeledField label={T.fPerson}>{(id) => <PersonPicker id={id} value={person} onChange={setPerson} activeOnly />}</LabeledField>
        ) : null}
        {action === 'LOAN' ? (
          <LabeledField label={T.fDue}>
            {(id) => <input id={id} type="date" min={todayIso()} required style={smallInput} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
          </LabeledField>
        ) : null}
        {action === 'RETURN' ? (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 12 }}>
            <input type="checkbox" checked={defective} onChange={(e) => setDefective(e.target.checked)} />
            {T.fDefective}
          </label>
        ) : null}
        {action === 'DISPOSE' ? (
          <LabeledField label={T.fDisposal}>
            {(id) => (
              <select id={id} required style={smallInput} value={disposal} onChange={(e) => setDisposal(e.target.value as typeof disposal)}>
                <option value="" />
                {(Object.keys(DISPOSAL_LABEL) as (keyof typeof DISPOSAL_LABEL)[]).map((k) => (
                  <option key={k} value={k}>{DISPOSAL_LABEL[k]}</option>
                ))}
              </select>
            )}
          </LabeledField>
        ) : null}
        {TAKES_LOCATION.has(action) ? (
          <LabeledField label={T.fLocation} hint={T.fLocationHint}>
            {(id) => <input id={id} style={smallInput} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} autoComplete="off" />}
          </LabeledField>
        ) : null}
        <LabeledField label={T.fNote}>
          {(id) => <textarea id={id} style={{ ...smallInput, minHeight: 60, fontFamily: 'inherit' }} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
        </LabeledField>
        {destructive ? (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 12 }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {T.confirm}
          </label>
        ) : null}
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant={destructive ? 'danger' : 'primary'} disabled={busy || (destructive && !confirmed)}>
            {busy ? T.processing : label}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
