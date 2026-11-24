'use client';
import { useState, type FormEvent } from 'react';
import { useShell } from '../../../shell';
import { api, Button, ErrorText, LabeledField, Modal, smallInput } from '../../../ui';
import { CustomFieldInputs, draftFromValues, FilterableSelect, listOf, modelLabel, parseCustom, useList, type CustomDraft } from '../shared';
import type { AssetRow, CustomFieldDef, DepartmentOption, ModelOption } from '../types';

const T = {
  title: (tag: string) => `자산 수정 — ${tag}`,
  fModel: '모델',
  fTag: '자산 태그',
  fSerial: '시리얼 번호',
  fDept: '관리 부서',
  fDeptHint: '관리 부서를 바꾸면 이력에 남습니다.',
  fLocation: '위치',
  fPurchaseDate: '구매일',
  fWarranty: '보증 만료일',
  fPrice: '구매가',
  fSupplier: '공급업체',
  customTitle: '사용자 지정 필드',
  customHint: '값을 비우면 그 필드의 값을 지웁니다.',
  inactive: '(사용 안 함)',
  stateNote: '상태와 보유자는 여기서 바꾸지 않습니다. 상세 화면의 처리 버튼을 쓰세요.',
  nothing: '바뀐 내용이 없습니다.',
  priceInvalid: '구매가는 0 이상의 숫자로 입력하세요.',
  customInvalid: (label: string) => `"${label}" 값의 형식이 올바르지 않습니다.`,
  cancel: '취소',
  save: '저장',
  saving: '저장 중…',
};

/** 문자열 입력칸의 값. 비어 있으면 null(= 지우기). */
const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

/**
 * 수정 대화상자. 바뀐 항목만 보낸다(PATCH 는 정의하지 않은 키를 거부하고, 빠진 키는 "그대로", null 은 "지우기"다).
 * onGone: 서버가 404 를 답했을 때(범위 밖으로 옮겨졌거나 다른 사람이 바꿈) 부모가 다시 불러오게 한다.
 */
export function EditAssetDialog({
  asset,
  onClose,
  onSaved,
  onGone,
}: {
  asset: AssetRow;
  onClose: () => void;
  onSaved: () => void;
  onGone: (message: string) => void;
}) {
  const { can, perms } = useShell();
  const models = useList<ModelOption>(can('master.model', 'read') ? '/api/master/models?kind=ASSET&includeInactive=true' : null, 'models');
  // 관리 부서 변경은 부서 범위 제한이 없는 사용자만 할 수 있다(서버도 같은 규칙으로 거부한다).
  const unrestricted = perms.all || perms.departmentScope === null;
  const departments = useList<DepartmentOption>(unrestricted && can('master.department', 'read') ? '/api/departments' : null, 'departments');
  const fields = useList<CustomFieldDef>(can('master.custom_field', 'read') ? '/api/master/custom-fields' : null, 'fields');
  // 제한 필드는 읽을 수도 있어야 고치게 한다(보이지 않는 값을 모르고 덮어쓰지 않도록).
  const canRestricted = can('asset.item.custom_restricted', 'update') && can('asset.item.custom_restricted', 'read');
  const defs = listOf(fields).filter((d) => d.is_active && (!d.is_restricted || canRestricted));
  // 구매가·공급업체: 응답에 키가 있고(읽기 권한) 수정 권한도 있을 때만 입력칸을 보인다.
  const showPrice = 'purchase_price' in asset && can('asset.item.purchase_price', 'update');
  const showSupplier = 'supplier' in asset && can('asset.item.supplier', 'update');

  // 새로 고를 수 있는 것은 활성 모델·부서뿐이다. 현재 값은 비활성이어도 남겨 둔다.
  const modelOptions = listOf(models)
    .filter((m) => m.kind === 'ASSET' && (m.is_active || m.id === asset.model_id))
    .map((m) => ({ value: m.id, label: `${modelLabel(m)} (${m.category_name})${m.is_active ? '' : ` ${T.inactive}`}` }));
  const deptOptions = listOf(departments).filter((d) => d.is_active || d.id === asset.department_id);

  const initialPrice = asset.purchase_price === undefined || asset.purchase_price === null ? '' : String(asset.purchase_price);
  const [modelId, setModelId] = useState(asset.model_id);
  const [assetTag, setAssetTag] = useState(asset.asset_tag);
  const [serial, setSerial] = useState(asset.serial_number ?? '');
  const [departmentId, setDepartmentId] = useState(asset.department_id);
  const [location, setLocation] = useState(asset.location ?? '');
  const [purchaseDate, setPurchaseDate] = useState(asset.purchase_date ?? '');
  const [warrantyEnd, setWarrantyEnd] = useState(asset.warranty_end ?? '');
  const [price, setPrice] = useState(initialPrice);
  const [supplier, setSupplier] = useState(asset.supplier ?? '');
  const [custom, setCustom] = useState<CustomDraft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 정의를 불러온 뒤에 현재 값으로 채운다.
  const initialCustom = draftFromValues(defs, asset.custom);
  const draft = custom ?? initialCustom;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const patch: Record<string, unknown> = {};
    if (modelId && modelId !== asset.model_id) patch.modelId = modelId;
    if (assetTag.trim() !== asset.asset_tag) patch.assetTag = assetTag.trim();
    if (orNull(serial) !== asset.serial_number) patch.serialNumber = orNull(serial);
    if (unrestricted && departmentId !== asset.department_id) patch.departmentId = departmentId;
    if (orNull(location) !== asset.location) patch.location = orNull(location);
    if ((purchaseDate || null) !== asset.purchase_date) patch.purchaseDate = purchaseDate || null;
    if ((warrantyEnd || null) !== asset.warranty_end) patch.warrantyEnd = warrantyEnd || null;
    if (showPrice && price.trim() !== initialPrice) {
      const n = price.trim() === '' ? null : Number(price.trim());
      if (n !== null && (!Number.isFinite(n) || n < 0)) return setError(T.priceInvalid);
      patch.purchasePrice = n;
    }
    if (showSupplier && orNull(supplier) !== (asset.supplier ?? null)) patch.supplier = orNull(supplier);
    const customPatch: Record<string, unknown> = {};
    for (const d of defs) {
      const raw = draft[d.key] ?? '';
      if (raw === (initialCustom[d.key] ?? '')) continue;
      const v = parseCustom(d, raw);
      if (v === undefined) return setError(T.customInvalid(d.label));
      customPatch[d.key] = v;
    }
    if (Object.keys(customPatch).length > 0) patch.custom = customPatch;
    if (Object.keys(patch).length === 0) return setError(T.nothing);

    setBusy(true);
    const r = await api<{ ok: true }>('PATCH', `/api/assets/${encodeURIComponent(asset.id)}`, patch);
    setBusy(false);
    if (r.ok) onSaved();
    else if (r.redirected) return;
    else if (r.status === 404) onGone(r.error.message);
    else setError(r.error.message);
  }

  return (
    <Modal title={T.title(asset.asset_tag)} onClose={onClose} width={560}>
      <form onSubmit={submit}>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 10px' }}>{T.stateNote}</p>
        {modelOptions.length > 0 ? (
          <LabeledField label={T.fModel}>
            {(id) => <FilterableSelect id={id} options={modelOptions} value={modelId} onChange={setModelId} required />}
          </LabeledField>
        ) : null}
        <LabeledField label={T.fTag}>
          {(id) => <input id={id} style={smallInput} value={assetTag} onChange={(e) => setAssetTag(e.target.value)} required maxLength={64} autoComplete="off" />}
        </LabeledField>
        <LabeledField label={T.fSerial}>
          {(id) => <input id={id} style={smallInput} value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={100} autoComplete="off" />}
        </LabeledField>
        {deptOptions.length > 0 ? (
          <LabeledField label={T.fDept} hint={T.fDeptHint}>
            {(id) => (
              <select id={id} style={smallInput} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ` ${T.inactive}`}</option>
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
        {showPrice ? (
          <LabeledField label={T.fPrice}>
            {(id) => <input id={id} type="number" min={0} step="any" style={smallInput} value={price} onChange={(e) => setPrice(e.target.value)} />}
          </LabeledField>
        ) : null}
        {showSupplier ? (
          <LabeledField label={T.fSupplier}>
            {(id) => <input id={id} style={smallInput} value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={200} autoComplete="off" />}
          </LabeledField>
        ) : null}
        {defs.length > 0 ? (
          <fieldset style={{ border: '1px solid #e2e5ea', borderRadius: 6, padding: '8px 12px', margin: '4px 0 12px' }}>
            <legend style={{ fontSize: 13, color: '#4b5563', padding: '0 4px' }}>{T.customTitle}</legend>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>{T.customHint}</div>
            <CustomFieldInputs defs={defs} draft={draft} onChange={setCustom} />
          </fieldset>
        ) : null}
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || fields === null}>{busy ? T.saving : T.save}</Button>
        </div>
      </form>
    </Modal>
  );
}
