'use client';
import { useState, type FormEvent } from 'react';
import { useShell } from '../../shell';
import { api, Button, ErrorText, LabeledField, Modal, Notice, smallInput } from '../../ui';
import { FilterableSelect, listOf, modelLabel, useList } from '../assets/shared';
import type { DepartmentOption, ModelOption } from '../assets/types';
import { KIND_LABEL, MAX_MIN_QTY, MAX_RATIO, MIN_RATIO, recoverAt, TARGET_TYPE_LABEL, type ItemKind, type TargetType, type ThresholdRow } from './labels';

const T = {
  createTitle: '한계 수량 추가',
  editTitle: (name: string) => `한계 수량 수정 — ${name}`,
  fTargetType: '대상 종류',
  fCategory: '카테고리',
  fModel: '모델',
  fDept: '부서',
  deptAll: '전체 (기업 전체 수량)',
  deptChoose: '선택하세요',
  deptScopedHint: '내 부서 범위 안의 부서만 고를 수 있습니다. 기업 전체 한계 수량은 부서 범위 제한이 없는 사용자만 만들 수 있습니다.',
  deptUnavailableAll: '부서 목록을 볼 권한이 없어 기업 전체 한계 수량만 만들 수 있습니다.',
  deptUnavailableScoped: '부서 목록을 볼 권한이 없고 기업 전체 한계 수량도 만들 수 없어, 한계 수량을 추가할 수 없습니다.',
  targetUnavailable: (what: string) => `${what} 목록을 볼 권한이 없어 이 종류로는 추가할 수 없습니다.`,
  targetNone: (what: string) => `고를 수 있는 ${what}이(가) 없습니다. 기준 정보에서 먼저 등록하세요.`,
  fMinQty: '한계 수량',
  fMinQtyHint: '사용 가능 수량이 이 값보다 적어지면 부족 알림을 보냅니다.',
  fRatio: '여유 비율',
  fRatioHint: '부족 알림 뒤에는 수량이 한계 수량 × 이 비율 이상으로 회복해야 정상으로 돌아옵니다. 경계에서 수량이 오르내릴 때 알림이 반복되지 않게 합니다. (1 ~ 10, 기본 1)',
  recoverPreview: (n: number) => `회복 기준: ${n.toLocaleString('ko-KR')}개 이상`,
  fActive: '사용',
  fActiveHint: '끄면 부족 판정과 알림을 멈춥니다. 다시 켜면 정상 상태에서 새로 판정합니다.',
  fixed: '대상과 부서는 바꿀 수 없습니다. 바꾸려면 이 한계 수량을 지우고 새로 만드세요.',
  fixedTarget: '대상',
  fixedDept: '부서',
  all: '전체',
  targetRequired: '대상을 고르세요.',
  deptRequired: '부서를 고르세요.',
  minQtyInvalid: `한계 수량은 0 이상 ${MAX_MIN_QTY.toLocaleString('ko-KR')} 이하의 정수로 입력하세요.`,
  ratioInvalid: `여유 비율은 ${MIN_RATIO} 이상 ${MAX_RATIO} 이하, 소수 둘째 자리까지 입력하세요.`,
  nothingChanged: '바뀐 내용이 없습니다.',
  cancel: '취소',
  create: '추가',
  save: '저장',
  saving: '저장 중…',
};

interface CategoryOption {
  id: string;
  kind: ItemKind;
  name: string;
  is_active: boolean;
}

function parseMinQty(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_MIN_QTY ? n : null;
}

/** DB 는 소수 둘째 자리까지 저장한다(numeric(5,2)). 그보다 긴 값은 받지 않는다. */
function parseRatio(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_RATIO && n <= MAX_RATIO ? n : null;
}

function RecoverHint({ minQty, ratio }: { minQty: string; ratio: string }) {
  const q = parseMinQty(minQty);
  const r = parseRatio(ratio);
  if (q === null || r === null) return null;
  return <p style={{ fontSize: 13, color: '#374151', margin: '-4px 0 12px' }}>{T.recoverPreview(recoverAt({ min_qty: q, warn_ratio: r }))}</p>;
}

function QtyAndRatio({ minQty, setMinQty, ratio, setRatio }: { minQty: string; setMinQty: (v: string) => void; ratio: string; setRatio: (v: string) => void }) {
  return (
    <>
      <LabeledField label={T.fMinQty} hint={T.fMinQtyHint}>
        {(id) => (
          <input id={id} type="number" inputMode="numeric" min={0} max={MAX_MIN_QTY} step={1} required style={smallInput} value={minQty} onChange={(e) => setMinQty(e.target.value)} />
        )}
      </LabeledField>
      <LabeledField label={T.fRatio} hint={T.fRatioHint}>
        {(id) => (
          <input id={id} type="number" inputMode="decimal" min={MIN_RATIO} max={MAX_RATIO} step={0.01} required style={smallInput} value={ratio} onChange={(e) => setRatio(e.target.value)} />
        )}
      </LabeledField>
      <RecoverHint minQty={minQty} ratio={ratio} />
    </>
  );
}

export function CreateThresholdDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { can, perms } = useShell();
  const categories = useList<CategoryOption>(can('master.category', 'read') ? '/api/master/categories' : null, 'categories');
  const models = useList<ModelOption>(can('master.model', 'read') ? '/api/master/models' : null, 'models');
  const departments = useList<DepartmentOption>(can('master.department', 'read') ? '/api/departments' : null, 'departments');

  const scope = perms.departmentScope;
  // 기업 전체 한계 수량은 범위 제한이 없는 사용자만 만들 수 있다(서버가 거부한다).
  const allowAll = scope === null;
  const deptOptions = listOf(departments).filter((d) => d.is_active && (scope === null || scope.includes(d.id)));

  const [targetType, setTargetType] = useState<TargetType>('category');
  const [targetId, setTargetId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [minQty, setMinQty] = useState('');
  const [ratio, setRatio] = useState('1');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const source = targetType === 'category' ? categories : models;
  const options =
    targetType === 'category'
      ? listOf(categories).filter((c) => c.is_active).map((c) => ({ value: c.id, label: `${c.name} · ${KIND_LABEL[c.kind]}` }))
      : listOf(models).filter((m) => m.is_active).map((m) => ({ value: m.id, label: `${modelLabel(m)} (${m.category_name}) · ${KIND_LABEL[m.kind]}` }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!targetId) return setError(T.targetRequired);
    if (!departmentId && !allowAll) return setError(T.deptRequired);
    const q = parseMinQty(minQty);
    if (q === null) return setError(T.minQtyInvalid);
    const r = parseRatio(ratio);
    if (r === null) return setError(T.ratioInvalid);
    const body: Record<string, unknown> = { minQty: q, warnRatio: r };
    body[targetType === 'category' ? 'categoryId' : 'modelId'] = targetId;
    if (departmentId) body.departmentId = departmentId;
    setBusy(true);
    const res = await api<{ thresholdId: string }>('POST', '/api/thresholds', body);
    setBusy(false);
    if (res.ok) onDone();
    else if (!res.redirected) setError(res.error.message);
  }

  if (departments === 'denied' && !allowAll) {
    return (
      <Modal title={T.createTitle} onClose={onClose} width={480}>
        <Notice>{T.deptUnavailableScoped}</Notice>
      </Modal>
    );
  }

  const what = TARGET_TYPE_LABEL[targetType];
  return (
    <Modal title={T.createTitle} onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px', fontSize: 14 }}>
          <legend style={{ fontSize: 13, color: '#4b5563', padding: 0, marginBottom: 4 }}>{T.fTargetType}</legend>
          {(Object.keys(TARGET_TYPE_LABEL) as TargetType[]).map((t) => (
            <label key={t} style={{ marginRight: 16 }}>
              <input type="radio" name="targetType" value={t} checked={targetType === t} onChange={() => { setTargetType(t); setTargetId(''); }} /> {TARGET_TYPE_LABEL[t]}
            </label>
          ))}
        </fieldset>
        {source === 'denied' ? (
          <Notice>{T.targetUnavailable(what)}</Notice>
        ) : Array.isArray(source) && options.length === 0 ? (
          <Notice>{T.targetNone(what)}</Notice>
        ) : (
          <LabeledField label={targetType === 'category' ? T.fCategory : T.fModel}>
            {(id) => <FilterableSelect key={targetType} id={id} options={options} value={targetId} onChange={setTargetId} required />}
          </LabeledField>
        )}
        {departments === 'denied' ? <Notice>{T.deptUnavailableAll}</Notice> : (
          <LabeledField label={T.fDept} hint={allowAll ? undefined : T.deptScopedHint}>
            {(id) => (
              <select id={id} style={smallInput} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required={!allowAll}>
                {allowAll ? <option value="">{T.deptAll}</option> : <option value="" disabled>{T.deptChoose}</option>}
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
          </LabeledField>
        )}
        <QtyAndRatio minQty={minQty} setMinQty={setMinQty} ratio={ratio} setRatio={setRatio} />
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || source === null || departments === null || source === 'denied'}>{busy ? T.saving : T.create}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function EditThresholdDialog({ threshold, onClose, onDone }: { threshold: ThresholdRow; onClose: () => void; onDone: () => void }) {
  const [minQty, setMinQty] = useState(String(threshold.min_qty));
  const [ratio, setRatio] = useState(String(threshold.warn_ratio));
  const [active, setActive] = useState(threshold.is_active);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const q = parseMinQty(minQty);
    if (q === null) return setError(T.minQtyInvalid);
    const r = parseRatio(ratio);
    if (r === null) return setError(T.ratioInvalid);
    // 바뀐 것만 보낸다(감사 로그에 바뀐 값만 남도록).
    const body: Record<string, unknown> = {};
    if (q !== threshold.min_qty) body.minQty = q;
    if (r !== threshold.warn_ratio) body.warnRatio = r;
    if (active !== threshold.is_active) body.isActive = active;
    if (Object.keys(body).length === 0) return setError(T.nothingChanged);
    setBusy(true);
    const res = await api<{ ok: true }>('PATCH', `/api/thresholds/${encodeURIComponent(threshold.id)}`, body);
    setBusy(false);
    if (res.ok) onDone();
    else if (!res.redirected) setError(res.error.message);
  }

  return (
    <Modal title={T.editTitle(threshold.target_name)} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <dl style={{ display: 'grid', gridTemplateColumns: '60px 1fr', rowGap: 4, fontSize: 14, margin: '0 0 6px' }}>
          <dt style={{ color: '#6b7280' }}>{T.fixedTarget}</dt>
          <dd style={{ margin: 0 }}>{threshold.target_name} · {KIND_LABEL[threshold.kind]}</dd>
          <dt style={{ color: '#6b7280' }}>{T.fixedDept}</dt>
          <dd style={{ margin: 0 }}>{threshold.department_name ?? T.all}</dd>
        </dl>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>{T.fixed}</p>
        <QtyAndRatio minQty={minQty} setMinQty={setMinQty} ratio={ratio} setRatio={setRatio} />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {T.fActive}
        </label>
        <div style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 12px' }}>{T.fActiveHint}</div>
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? T.saving : T.save}</Button>
        </div>
      </form>
    </Modal>
  );
}
