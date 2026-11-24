'use client';
import { useState, type FormEvent } from 'react';
import { useShell } from '../../shell';
import { api, Button, ErrorText, LabeledField, Modal, Notice, smallInput } from '../../ui';
import { STATE_LABEL } from './labels';
import { CustomFieldInputs, FilterableSelect, listOf, modelLabel, parseCustom, useList, type CustomDraft, type Loaded } from './shared';
import type { CustomFieldDef, DepartmentOption, ModelOption } from './types';

const T = {
  title: '자산 등록',
  fModel: '모델',
  fModelNone: '등록할 수 있는 자산용 모델이 없습니다. 기준 정보 > 모델에서 먼저 등록하세요.',
  fModelUnavailable: '모델 목록을 볼 권한이 없어 자산을 등록할 수 없습니다.',
  fTag: '자산 태그',
  fTagHint: '기업 안에서 고유합니다. 등록 취소된 자산의 태그도 다시 쓸 수 없습니다.',
  fSerial: '시리얼 번호 (선택)',
  fDept: '관리 부서',
  fDeptDefault: '지정 안 함 (기본 부서)',
  fDeptChoose: '선택하세요',
  fDeptHint: '내 부서 범위 안의 부서에만 등록할 수 있습니다.',
  fLocation: '위치 (선택)',
  fPurchaseDate: '구매일 (선택)',
  fWarranty: '보증 만료일 (선택)',
  fState: '처음 상태',
  fPrice: '구매가 (선택)',
  fSupplier: '공급업체 (선택)',
  customTitle: '사용자 지정 필드',
  priceInvalid: '구매가는 0 이상의 숫자로 입력하세요.',
  customInvalid: (label: string) => `"${label}" 값의 형식이 올바르지 않습니다.`,
  cancel: '취소',
  create: '등록',
  saving: '저장 중…',
};

export function CreateAssetDialog({
  models,
  departments,
  onClose,
  onCreated,
}: {
  models: Loaded<ModelOption>;
  departments: Loaded<DepartmentOption>;
  onClose: () => void;
  onCreated: (assetId: string, assetTag: string) => void;
}) {
  const { can, perms } = useShell();
  const canPrice = can('asset.item.purchase_price', 'update');
  const canSupplier = can('asset.item.supplier', 'update');
  const canRestricted = can('asset.item.custom_restricted', 'update');
  const fields = useList<CustomFieldDef>(can('master.custom_field', 'read') ? '/api/master/custom-fields' : null, 'fields');
  const defs = listOf(fields).filter((d) => d.is_active && (!d.is_restricted || canRestricted));

  const modelOptions = listOf(models)
    .filter((m) => m.kind === 'ASSET' && m.is_active)
    .map((m) => ({ value: m.id, label: `${modelLabel(m)} (${m.category_name})` }));
  const scope = perms.departmentScope;
  const deptOptions = listOf(departments).filter((d) => d.is_active && (scope === null || scope.includes(d.id)));
  // 비워 두면 서버가 기본 부서에 등록한다. 기본 부서가 내 범위 밖이면 서버가 거부하므로 직접 고르게 한다.
  const defaultAllowed = scope === null || deptOptions.some((d) => d.is_default);

  const [modelId, setModelId] = useState('');
  const [assetTag, setAssetTag] = useState('');
  const [serial, setSerial] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [location, setLocation] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [warrantyEnd, setWarrantyEnd] = useState('');
  const [initialState, setInitialState] = useState<'IN_STOCK' | 'ON_ORDER'>('IN_STOCK');
  const [price, setPrice] = useState('');
  const [supplier, setSupplier] = useState('');
  const [custom, setCustom] = useState<CustomDraft>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    // 비어 있는 선택 항목은 보내지 않는다(서버 기본값을 쓴다).
    const body: Record<string, unknown> = { modelId, assetTag: assetTag.trim(), initialState };
    if (serial.trim()) body.serialNumber = serial.trim();
    if (departmentId) body.departmentId = departmentId;
    if (location.trim()) body.location = location.trim();
    if (purchaseDate) body.purchaseDate = purchaseDate;
    if (warrantyEnd) body.warrantyEnd = warrantyEnd;
    if (canPrice && price.trim()) {
      const n = Number(price.trim());
      if (!Number.isFinite(n) || n < 0) return setError(T.priceInvalid);
      body.purchasePrice = n;
    }
    if (canSupplier && supplier.trim()) body.supplier = supplier.trim();
    const values: Record<string, unknown> = {};
    for (const d of defs) {
      const v = parseCustom(d, custom[d.key] ?? '');
      if (v === undefined) return setError(T.customInvalid(d.label));
      if (v !== null) values[d.key] = v;
    }
    if (Object.keys(values).length > 0) body.custom = values;

    setBusy(true);
    const r = await api<{ assetId: string }>('POST', '/api/assets', body);
    setBusy(false);
    if (r.ok) onCreated(r.data.assetId, assetTag.trim());
    else if (!r.redirected) setError(r.error.message);
  }

  if (models === 'denied' || (Array.isArray(models) && modelOptions.length === 0)) {
    return (
      <Modal title={T.title} onClose={onClose} width={480}>
        <Notice>{models === 'denied' ? T.fModelUnavailable : T.fModelNone}</Notice>
      </Modal>
    );
  }

  return (
    <Modal title={T.title} onClose={onClose} width={560}>
      <form onSubmit={submit}>
        <LabeledField label={T.fModel}>
          {(id) => <FilterableSelect id={id} options={modelOptions} value={modelId} onChange={setModelId} required />}
        </LabeledField>
        <LabeledField label={T.fTag} hint={T.fTagHint}>
          {(id) => <input id={id} style={smallInput} value={assetTag} onChange={(e) => setAssetTag(e.target.value)} required maxLength={64} autoComplete="off" />}
        </LabeledField>
        <LabeledField label={T.fSerial}>
          {(id) => <input id={id} style={smallInput} value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={100} autoComplete="off" />}
        </LabeledField>
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
        <LabeledField label={T.fLocation}>
          {(id) => <input id={id} style={smallInput} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} autoComplete="off" />}
        </LabeledField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <LabeledField label={T.fPurchaseDate}>
            {(id) => <input id={id} type="date" style={smallInput} value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />}
          </LabeledField>
          <LabeledField label={T.fWarranty}>
            {(id) => <input id={id} type="date" style={smallInput} value={warrantyEnd} onChange={(e) => setWarrantyEnd(e.target.value)} />}
          </LabeledField>
        </div>
        <LabeledField label={T.fState}>
          {(id) => (
            <select id={id} style={smallInput} value={initialState} onChange={(e) => setInitialState(e.target.value === 'ON_ORDER' ? 'ON_ORDER' : 'IN_STOCK')}>
              <option value="IN_STOCK">{STATE_LABEL.IN_STOCK}</option>
              <option value="ON_ORDER">{STATE_LABEL.ON_ORDER}</option>
            </select>
          )}
        </LabeledField>
        {canPrice ? (
          <LabeledField label={T.fPrice}>
            {(id) => <input id={id} type="number" min={0} step="any" style={smallInput} value={price} onChange={(e) => setPrice(e.target.value)} />}
          </LabeledField>
        ) : null}
        {canSupplier ? (
          <LabeledField label={T.fSupplier}>
            {(id) => <input id={id} style={smallInput} value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={200} autoComplete="off" />}
          </LabeledField>
        ) : null}
        {defs.length > 0 ? (
          <fieldset style={{ border: '1px solid #e2e5ea', borderRadius: 6, padding: '8px 12px', margin: '4px 0 12px' }}>
            <legend style={{ fontSize: 13, color: '#4b5563', padding: '0 4px' }}>{T.customTitle}</legend>
            <CustomFieldInputs defs={defs} draft={custom} onChange={setCustom} />
          </fieldset>
        ) : null}
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || models === null}>{busy ? T.saving : T.create}</Button>
        </div>
      </form>
    </Modal>
  );
}
