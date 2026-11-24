'use client';
import { useState, type FormEvent } from 'react';
import { useShell } from '../../shell';
import { api, Button, ErrorText, LabeledField, Modal, Notice, smallInput } from '../../ui';
import { FilterableSelect, listOf, modelLabel, type Loaded } from '../assets/shared';
import type { DepartmentOption, ModelOption } from '../assets/types';
import { NoteField, useParseQty, QtyField } from './shared';
import { MAX_QTY } from './types';
import { useT } from '../../i18n';
import { TEXT } from './receive-dialog.text';

export function ReceiveDialog({
  models,
  departments,
  onClose,
  onDone,
}: {
  models: Loaded<ModelOption>;
  departments: Loaded<DepartmentOption>;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const T = useT(TEXT);
  const parseQty = useParseQty();
  const { perms } = useShell();
  const modelOptions = listOf(models)
    .filter((m) => m.kind === 'PERIPHERAL' && m.is_active)
    .map((m) => ({ value: m.id, label: `${modelLabel(m)} (${m.category_name})` }));
  const scope = perms.departmentScope;
  const deptOptions = listOf(departments).filter((d) => d.is_active && (scope === null || scope.includes(d.id)));
  // 비워 두면 서버가 기본 부서에 입고한다. 기본 부서가 내 범위 밖이면 서버가 거부하므로 직접 고르게 한다.
  const defaultAllowed = scope === null || deptOptions.some((d) => d.is_default);
  const deptDenied = departments === 'denied';

  const [modelId, setModelId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!modelId) return setError(T.modelRequired);
    if (!departmentId && !defaultAllowed) return setError(T.deptRequired);
    const q = parseQty(qty, 1, MAX_QTY);
    if ('error' in q) return setError(q.error);
    const body: Record<string, unknown> = { modelId, qty: q.qty };
    if (departmentId) body.departmentId = departmentId;
    if (note.trim()) body.note = note.trim();
    setBusy(true);
    const r = await api<{ stockId: string; onHandQty: number }>('POST', '/api/peripherals/receive', body);
    setBusy(false);
    if (r.ok) onDone(T.done(r.data.onHandQty));
    else if (!r.redirected) setError(r.error.message);
  }

  const blocked = models === 'denied' || (Array.isArray(models) && modelOptions.length === 0) || (deptDenied && scope !== null);
  if (blocked) {
    return (
      <Modal title={T.title} onClose={onClose} width={480}>
        <Notice>{models === 'denied' ? T.fModelUnavailable : deptDenied && scope !== null ? T.fDeptBlocked : T.fModelNone}</Notice>
      </Modal>
    );
  }

  return (
    <Modal title={T.title} onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <LabeledField label={T.fModel}>
          {(id) => <FilterableSelect id={id} options={modelOptions} value={modelId} onChange={setModelId} required />}
        </LabeledField>
        {deptDenied ? <Notice>{T.fDeptUnavailable}</Notice> : null}
        {deptOptions.length > 0 ? (
          <LabeledField label={T.fDept} hint={scope === null ? undefined : T.fDeptHint}>
            {(id) => (
              <select id={id} style={smallInput} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required={!defaultAllowed}>
                <option value="">{defaultAllowed ? T.fDeptDefault : T.fDeptChoose}</option>
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
          </LabeledField>
        ) : null}
        <QtyField label={T.fQty} value={qty} onChange={setQty} min={1} />
        <NoteField label={T.fNote} value={note} onChange={setNote} />
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || models === null || departments === null}>{busy ? T.saving : T.submit}</Button>
        </div>
      </form>
    </Modal>
  );
}
