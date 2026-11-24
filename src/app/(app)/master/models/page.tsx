'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import { api, Badge, Button, ConfirmDialog, EmptyRow, ErrorText, LabeledField, Modal, Notice, PageHeader, smallInput, Table, td } from '../../../ui';

type Kind = 'ASSET' | 'PERIPHERAL';

const T = {
  title: '모델',
  add: '모델 추가',
  loading: '불러오는 중…',
  empty: '조건에 맞는 모델이 없습니다.',
  filterKind: '종류',
  filterCategory: '카테고리',
  filterQ: '검색',
  filterQPlaceholder: '제조사 또는 모델명',
  search: '검색',
  all: '전체',
  kind: { ASSET: '자산', PERIPHERAL: '주변기기' } satisfies Record<Kind, string>,
  includeInactive: '사용 안 함 포함',
  colManufacturer: '제조사',
  colName: '모델명',
  colCategory: '카테고리',
  colKind: '종류',
  colStatus: '상태',
  colActions: '작업',
  active: '사용',
  inactive: '사용 안 함',
  categoryInactive: '(카테고리 사용 안 함)',
  edit: '수정',
  activate: '활성화',
  deactivate: '비활성화',
  remove: '삭제',
  saved: '저장했습니다.',
  categoriesUnavailable: '카테고리 목록을 볼 권한이 없어 모델을 등록하거나 카테고리를 바꿀 수 없습니다.',
  confirmActivateTitle: '모델 활성화',
  confirmActivate: (n: string) => `"${n}" 모델을 다시 사용합니다. 자산·재고를 등록할 때 고를 수 있게 됩니다.`,
  confirmDeactivateTitle: '모델 비활성화',
  confirmDeactivate: (n: string) => `"${n}" 모델을 비활성화합니다. 기존 자산·재고는 그대로 남고, 새로 등록할 때 고를 수 없게 됩니다.`,
  confirmDeleteTitle: '모델 삭제',
  confirmDelete: (n: string) => `"${n}" 모델을 삭제합니다. 자산·주변기기 재고·한계수량에서 쓰는 모델은 삭제할 수 없으며, 그때는 비활성화하세요.`,
  formCreate: '모델 추가',
  formEdit: (n: string) => `모델 수정 — ${n}`,
  fCategory: '카테고리',
  fCategoryHintCreate: '모델의 종류(자산/주변기기)는 카테고리를 따릅니다.',
  fCategoryHintEdit: '같은 종류의 카테고리로만 옮길 수 있습니다.',
  fCategoryPick: '선택하세요',
  fManufacturer: '제조사',
  fName: '모델명',
  cancel: '취소',
  save: '저장',
  create: '만들기',
  saving: '저장 중…',
};

interface ModelRow {
  id: string;
  category_id: string;
  category_name: string;
  category_is_active: boolean;
  kind: Kind;
  manufacturer: string;
  name: string;
  is_active: boolean;
}

interface CategoryOption {
  id: string;
  kind: Kind;
  name: string;
  is_active: boolean;
}

type Pending = { kind: 'activate' | 'deactivate' | 'delete'; model: ModelRow } | null;
const label = (m: ModelRow) => `${m.manufacturer} ${m.name}`;

export default function ModelsPage() {
  return (
    <RequireCompany>
      <ModelsInner />
    </RequireCompany>
  );
}

function ModelsInner() {
  const { can } = useShell();
  const [kind, setKind] = useState<Kind | ''>('');
  const [categoryId, setCategoryId] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [rows, setRows] = useState<ModelRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  // null = 불러오는 중, 'denied' = 카테고리 조회 권한 없음
  const [categories, setCategories] = useState<CategoryOption[] | 'denied' | null>(null);
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; model: ModelRow } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (categoryId) params.set('categoryId', categoryId);
    if (q) params.set('q', q);
    if (includeInactive) params.set('includeInactive', 'true');
    const r = await api<{ models: ModelRow[] }>('GET', `/api/master/models?${params.toString()}`);
    if (r.ok) {
      setRows(r.data.models);
      setLoadError('');
    } else if (!r.redirected) setLoadError(r.error.message);
  }, [kind, categoryId, q, includeInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const r = await api<{ categories: CategoryOption[] }>('GET', '/api/master/categories?includeInactive=true');
      if (r.ok) setCategories(r.data.categories);
      else if (!r.redirected) setCategories('denied');
    })();
  }, []);

  const categoryList = Array.isArray(categories) ? categories : [];

  async function runPending(p: NonNullable<Pending>): Promise<string | null> {
    const base = `/api/master/models/${encodeURIComponent(p.model.id)}`;
    const r = p.kind === 'delete' ? await api<{ ok: true }>('DELETE', base) : await api<{ ok: true }>('POST', `${base}/${p.kind}`);
    if (!r.ok) return r.redirected ? null : r.error.message;
    setPending(null);
    setNotice(T.saved);
    void load();
    return null;
  }

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={
          can('master.model', 'create') ? (
            <Button variant="primary" disabled={!Array.isArray(categories)} onClick={() => { setNotice(''); setForm({ mode: 'create' }); }}>{T.add}</Button>
          ) : null
        }
      />
      {categories === 'denied' && (can('master.model', 'create') || can('master.model', 'update')) ? <Notice>{T.categoriesUnavailable}</Notice> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQ(qInput.trim());
        }}
        style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10, fontSize: 14, flexWrap: 'wrap' }}
      >
        <label>
          {T.filterKind}{' '}
          <select value={kind} onChange={(e) => { setKind(e.target.value as Kind | ''); setCategoryId(''); }} style={{ ...smallInput, width: 'auto', margin: 0 }}>
            <option value="">{T.all}</option>
            <option value="ASSET">{T.kind.ASSET}</option>
            <option value="PERIPHERAL">{T.kind.PERIPHERAL}</option>
          </select>
        </label>
        {categoryList.length > 0 ? (
          <label>
            {T.filterCategory}{' '}
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ ...smallInput, width: 'auto', margin: 0 }}>
              <option value="">{T.all}</option>
              {categoryList.filter((c) => !kind || c.kind === kind).map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.is_active ? '' : ` (${T.inactive})`}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          {T.filterQ}{' '}
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={T.filterQPlaceholder} maxLength={100} style={{ ...smallInput, width: 200, margin: 0 }} />
        </label>
        <Button type="submit" small>{T.search}</Button>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          {T.includeInactive}
        </label>
      </form>
      {notice ? <p role="status" style={{ color: '#166534', fontSize: 14 }}>{notice}</p> : null}
      <ErrorText>{loadError}</ErrorText>
      {rows === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {rows ? (
        <Table head={[T.colManufacturer, T.colName, T.colCategory, T.colKind, T.colStatus, T.colActions]}>
          {rows.length === 0 ? <EmptyRow colSpan={6}>{T.empty}</EmptyRow> : null}
          {rows.map((m) => (
            <tr key={m.id}>
              <td style={td}>{m.manufacturer}</td>
              <td style={td}>{m.name}</td>
              <td style={td}>
                {m.category_name}
                {m.category_is_active ? null : <span style={{ color: '#6b7280', fontSize: 12 }}> {T.categoryInactive}</span>}
              </td>
              <td style={td}><Badge tone={m.kind === 'ASSET' ? 'blue' : 'amber'}>{T.kind[m.kind]}</Badge></td>
              <td style={td}>{m.is_active ? <Badge tone="green">{T.active}</Badge> : <Badge tone="gray">{T.inactive}</Badge>}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {can('master.model', 'update') ? (
                    <Button small disabled={!Array.isArray(categories)} onClick={() => { setNotice(''); setForm({ mode: 'edit', model: m }); }}>{T.edit}</Button>
                  ) : null}
                  {m.is_active && can('master.model', 'deactivate') ? (
                    <Button small variant="danger" onClick={() => setPending({ kind: 'deactivate', model: m })}>{T.deactivate}</Button>
                  ) : null}
                  {!m.is_active && can('master.model', 'activate') ? (
                    <Button small onClick={() => setPending({ kind: 'activate', model: m })}>{T.activate}</Button>
                  ) : null}
                  {can('master.model', 'delete') ? (
                    <Button small variant="danger" onClick={() => setPending({ kind: 'delete', model: m })}>{T.remove}</Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}

      {form && Array.isArray(categories) ? (
        <ModelForm
          key={form.mode === 'edit' ? form.model.id : 'new'}
          model={form.mode === 'edit' ? form.model : null}
          categories={categories}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            setNotice(T.saved);
            void load();
          }}
        />
      ) : null}

      {pending ? (
        <ConfirmDialog
          title={pending.kind === 'activate' ? T.confirmActivateTitle : pending.kind === 'deactivate' ? T.confirmDeactivateTitle : T.confirmDeleteTitle}
          message={
            pending.kind === 'activate' ? T.confirmActivate(label(pending.model))
              : pending.kind === 'deactivate' ? T.confirmDeactivate(label(pending.model))
                : T.confirmDelete(label(pending.model))
          }
          confirmLabel={pending.kind === 'activate' ? T.activate : pending.kind === 'deactivate' ? T.deactivate : T.remove}
          danger={pending.kind !== 'activate'}
          onConfirm={() => runPending(pending)}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

function ModelForm({
  model,
  categories,
  onClose,
  onSaved,
}: {
  model: ModelRow | null;
  categories: CategoryOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [categoryId, setCategoryId] = useState(model?.category_id ?? '');
  const [manufacturer, setManufacturer] = useState(model?.manufacturer ?? '');
  const [name, setName] = useState(model?.name ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 새로 고를 수 있는 것은 활성 카테고리뿐이다. 수정할 때는 같은 종류만, 현재 카테고리는 비활성이어도 남겨 둔다.
  const options = categories.filter(
    (c) => (c.is_active && (!model || c.kind === model.kind)) || c.id === model?.category_id,
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const body = { categoryId, manufacturer: manufacturer.trim(), name: name.trim() };
    const r = model
      ? await api<{ ok: true }>('PATCH', `/api/master/models/${encodeURIComponent(model.id)}`, body)
      : await api<{ modelId: string }>('POST', '/api/master/models', body);
    setBusy(false);
    if (r.ok) onSaved();
    else if (!r.redirected) setError(r.error.message);
  }

  return (
    <Modal title={model ? T.formEdit(label(model)) : T.formCreate} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <LabeledField label={T.fCategory} hint={model ? T.fCategoryHintEdit : T.fCategoryHintCreate}>
          {(id) => (
            <select id={id} style={smallInput} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              <option value="" disabled>{T.fCategoryPick}</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {T.kind[c.kind]}{c.is_active ? '' : ` (${T.inactive})`}
                </option>
              ))}
            </select>
          )}
        </LabeledField>
        <LabeledField label={T.fManufacturer}>
          {(id) => <input id={id} style={smallInput} value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} required maxLength={100} />}
        </LabeledField>
        <LabeledField label={T.fName}>
          {(id) => <input id={id} style={smallInput} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />}
        </LabeledField>
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? T.saving : model ? T.save : T.create}</Button>
        </div>
      </form>
    </Modal>
  );
}
