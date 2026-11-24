'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import { api, Badge, Button, ConfirmDialog, EmptyRow, ErrorText, LabeledField, Modal, PageHeader, smallInput, Table, td } from '../../../ui';

type DataType = 'text' | 'number' | 'date' | 'boolean';

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

const T = {
  title: '사용자 지정 필드',
  add: '필드 추가',
  loading: '불러오는 중…',
  empty: '정의된 사용자 지정 필드가 없습니다.',
  intro: '자산에 기본 항목 외의 값을 저장할 때 씁니다. 제한 필드는 "제한 사용자 정의 항목" 권한이 있는 사용자에게만 보입니다.',
  colKey: '키',
  colLabel: '표시 이름',
  colType: '데이터 형식',
  colRestricted: '제한',
  colSort: '순서',
  colStatus: '상태',
  colActions: '작업',
  type: { text: '텍스트', number: '숫자', date: '날짜', boolean: '예/아니오' } satisfies Record<DataType, string>,
  restricted: '제한',
  active: '사용',
  inactive: '사용 안 함',
  edit: '수정',
  remove: '삭제',
  saved: '저장했습니다.',
  confirmDeleteTitle: '사용자 지정 필드 삭제',
  confirmDelete: (k: string) =>
    `"${k}" 필드 정의를 삭제합니다. 이 필드에 값이 저장된 자산이 하나라도 있으면 삭제할 수 없으며, 그때는 "사용 안 함"으로 바꾸세요.`,
  formCreate: '사용자 지정 필드 추가',
  formEdit: (k: string) => `사용자 지정 필드 수정 — ${k}`,
  fKey: '키',
  fKeyHint: '영문 소문자로 시작하고 영문 소문자·숫자·밑줄(_)만, 40자 이내. 만든 뒤에는 바꿀 수 없습니다.',
  fKeyInvalid: '키 형식이 올바르지 않습니다.',
  fLabel: '표시 이름',
  fType: '데이터 형식',
  fTypeHint: '만든 뒤에는 바꿀 수 없습니다.',
  fRestricted: '제한 필드 (권한이 있는 사용자에게만 보임)',
  fActive: '사용',
  fSort: '표시 순서',
  fSortInvalid: '표시 순서는 정수로 입력하세요.',
  cancel: '취소',
  save: '저장',
  create: '만들기',
  saving: '저장 중…',
};

interface FieldRow {
  id: string;
  key: string;
  label: string;
  data_type: DataType;
  is_restricted: boolean;
  sort_order: number;
  is_active: boolean;
}

export default function CustomFieldsPage() {
  return (
    <RequireCompany>
      <CustomFieldsInner />
    </RequireCompany>
  );
}

function CustomFieldsInner() {
  const { can } = useShell();
  const [rows, setRows] = useState<FieldRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; field: FieldRow } | null>(null);
  const [deleting, setDeleting] = useState<FieldRow | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ fields: FieldRow[] }>('GET', '/api/master/custom-fields');
    if (r.ok) {
      setRows(r.data.fields);
      setLoadError('');
    } else if (!r.redirected) setLoadError(r.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runDelete(f: FieldRow): Promise<string | null> {
    const r = await api<{ ok: true }>('DELETE', `/api/master/custom-fields/${encodeURIComponent(f.id)}`);
    if (!r.ok) return r.redirected ? null : r.error.message;
    setDeleting(null);
    setNotice(T.saved);
    void load();
    return null;
  }

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={can('master.custom_field', 'create') ? <Button variant="primary" onClick={() => { setNotice(''); setForm({ mode: 'create' }); }}>{T.add}</Button> : null}
      />
      <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 10px' }}>{T.intro}</p>
      {notice ? <p role="status" style={{ color: '#166534', fontSize: 14 }}>{notice}</p> : null}
      <ErrorText>{loadError}</ErrorText>
      {rows === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {rows ? (
        <Table head={[T.colKey, T.colLabel, T.colType, T.colRestricted, T.colSort, T.colStatus, T.colActions]}>
          {rows.length === 0 ? <EmptyRow colSpan={7}>{T.empty}</EmptyRow> : null}
          {rows.map((f) => (
            <tr key={f.id}>
              <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{f.key}</td>
              <td style={td}>{f.label}</td>
              <td style={td}>{T.type[f.data_type]}</td>
              <td style={td}>{f.is_restricted ? <Badge tone="red">{T.restricted}</Badge> : null}</td>
              <td style={{ ...td, textAlign: 'right' }}>{f.sort_order}</td>
              <td style={td}>{f.is_active ? <Badge tone="green">{T.active}</Badge> : <Badge tone="gray">{T.inactive}</Badge>}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  {can('master.custom_field', 'update') ? (
                    <Button small onClick={() => { setNotice(''); setForm({ mode: 'edit', field: f }); }}>{T.edit}</Button>
                  ) : null}
                  {can('master.custom_field', 'delete') ? (
                    <Button small variant="danger" onClick={() => setDeleting(f)}>{T.remove}</Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}

      {form ? (
        <FieldForm
          key={form.mode === 'edit' ? form.field.id : 'new'}
          field={form.mode === 'edit' ? form.field : null}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            setNotice(T.saved);
            void load();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={T.confirmDeleteTitle}
          message={T.confirmDelete(deleting.key)}
          confirmLabel={T.remove}
          danger
          onConfirm={() => runDelete(deleting)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

function FieldForm({ field, onClose, onSaved }: { field: FieldRow | null; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState(field?.key ?? '');
  const [labelText, setLabelText] = useState(field?.label ?? '');
  const [dataType, setDataType] = useState<DataType>(field?.data_type ?? 'text');
  const [isRestricted, setIsRestricted] = useState(field?.is_restricted ?? false);
  const [isActive, setIsActive] = useState(field?.is_active ?? true);
  const [sortOrder, setSortOrder] = useState(String(field?.sort_order ?? 0));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const sort = Number(sortOrder);
    if (!Number.isInteger(sort)) {
      setError(T.fSortInvalid);
      return;
    }
    if (!field && !KEY_RE.test(key)) {
      setError(T.fKeyInvalid);
      return;
    }
    const common = { label: labelText.trim(), isRestricted, isActive, sortOrder: sort };
    setBusy(true);
    const r = field
      ? await api<{ ok: true }>('PATCH', `/api/master/custom-fields/${encodeURIComponent(field.id)}`, common)
      : await api<{ fieldId: string }>('POST', '/api/master/custom-fields', { ...common, key, dataType });
    setBusy(false);
    if (r.ok) onSaved();
    else if (!r.redirected) setError(r.error.message);
  }

  return (
    <Modal title={field ? T.formEdit(field.key) : T.formCreate} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <LabeledField label={T.fKey} hint={T.fKeyHint}>
          {(id) => (
            <input
              id={id}
              style={{ ...smallInput, fontFamily: 'ui-monospace, monospace' }}
              value={key}
              disabled={field !== null}
              onChange={(e) => setKey(e.target.value)}
              required
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </LabeledField>
        <LabeledField label={T.fLabel}>
          {(id) => <input id={id} style={smallInput} value={labelText} onChange={(e) => setLabelText(e.target.value)} required maxLength={80} />}
        </LabeledField>
        <LabeledField label={T.fType} hint={T.fTypeHint}>
          {(id) => (
            <select id={id} style={smallInput} value={dataType} disabled={field !== null} onChange={(e) => setDataType(e.target.value as DataType)}>
              {(Object.keys(T.type) as DataType[]).map((t) => (
                <option key={t} value={t}>{T.type[t]}</option>
              ))}
            </select>
          )}
        </LabeledField>
        <LabeledField label={T.fSort}>
          {(id) => <input id={id} type="number" step={1} style={smallInput} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />}
        </LabeledField>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 8 }}>
          <input type="checkbox" checked={isRestricted} onChange={(e) => setIsRestricted(e.target.checked)} />
          {T.fRestricted}
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 12 }}>
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          {T.fActive}
        </label>
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? T.saving : field ? T.save : T.create}</Button>
        </div>
      </form>
    </Modal>
  );
}
