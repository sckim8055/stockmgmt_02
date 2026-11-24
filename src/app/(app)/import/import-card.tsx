'use client';
import Link from 'next/link';
import { useId, useState, type ChangeEvent } from 'react';
import { useShell } from '../../shell';
import { apiDownload, apiUpload, Button, ConfirmDialog, ErrorText } from '../../ui';
import { isImportResult, KIND_INFO, MAX_FILE_BYTES, type ImportKind, type ImportResult } from './labels';
import { CheckResult, CreatedList } from './result';

const T = {
  download: '양식 내려받기',
  downloading: '내려받는 중…',
  pickFile: '파일 고르기 (.xlsx)',
  noFile: '고른 파일 없음',
  fileInfo: (name: string, bytes: number) => `${name} (${(bytes / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} KB)`,
  notXlsx: '.xlsx 파일만 올릴 수 있습니다.',
  tooLarge: '파일이 너무 큽니다. (최대 5MB)',
  empty: '빈 파일입니다.',
  check: '검사',
  checking: '검사 중…',
  commit: '반영',
  committing: '반영 중…',
  confirmTitle: (title: string) => `${title} 업로드 반영`,
  confirmBody: (n: number) => `${n.toLocaleString('ko-KR')}행을 반영합니다. 반영한 뒤에는 한꺼번에 되돌릴 수 없고, 잘못 들어간 자료는 화면에서 하나씩 고쳐야 합니다.`,
  done: (n: number) => `${n.toLocaleString('ko-KR')}행을 반영했습니다.`,
};

/** 한 종류(직원·자산·주변기기)의 양식 내려받기 → 파일 고르기 → 검사 → 반영. */
export function ImportCard({ kind }: { kind: ImportKind }) {
  const info = KIND_INFO[kind];
  const { can } = useShell();
  const inputId = useId();
  const url = `/api/import/${kind}`;
  const [file, setFile] = useState<File | null>(null);
  // 결과는 어느 파일의 것인지 함께 둔다. 다른 파일을 고르면 다시 검사해야 반영할 수 있다.
  const [checked, setChecked] = useState<{ file: File; result: ImportResult; rejected: boolean } | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<'download' | 'preview' | 'commit' | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    // 같은 파일을 고친 뒤 다시 골라도 change 가 일어나도록 비워 둔다(고른 파일은 아래에 따로 보여 준다).
    e.target.value = '';
    setChecked(null);
    setDone(null);
    setError('');
    const problem = !f ? '' : !f.name.toLowerCase().endsWith('.xlsx') ? T.notXlsx : f.size > MAX_FILE_BYTES ? T.tooLarge : f.size === 0 ? T.empty : '';
    setError(problem);
    setFile(problem ? null : f);
  }

  async function download() {
    setBusy('download');
    setError('');
    const r = await apiDownload(url, info.templateFile);
    setBusy(null);
    if (!r.ok && !r.redirected) setError(r.error.message);
  }

  async function preview() {
    if (!file) return;
    setBusy('preview');
    setError('');
    setChecked(null);
    const r = await apiUpload<ImportResult>(`${url}?mode=preview`, file);
    setBusy(null);
    if (r.ok) setChecked({ file, result: r.data, rejected: false });
    else if (!r.redirected) setError(r.error.message);
  }

  async function commit(): Promise<string | null> {
    if (!file) return null;
    setBusy('commit');
    const r = await apiUpload<ImportResult>(`${url}?mode=commit`, file);
    setBusy(null);
    setConfirming(false);
    if (r.ok && r.data.committed) {
      setDone(r.data);
      setChecked(null);
      setFile(null);
    } else if (!r.ok && r.status === 422 && isImportResult(r.raw)) {
      // 검사한 뒤 자료가 바뀌었다(예: 그사이 같은 사번이 등록됨). 아무것도 반영되지 않았다.
      setChecked({ file, result: r.raw, rejected: true });
    } else if (!r.ok && !r.redirected) setError(r.error.message);
    return null;
  }

  const current = checked && checked.file === file ? checked : null;
  const ready = current !== null && !current.rejected && current.result.errors.length === 0 && current.result.totalRows > 0;

  return (
    <section aria-labelledby={`${inputId}-title`} style={{ background: '#fff', border: '1px solid #e2e5ea', borderRadius: 8, padding: '14px 16px' }}>
      <h2 id={`${inputId}-title`} style={{ fontSize: 16, margin: '0 0 4px' }}>{info.title}</h2>
      <p style={{ fontSize: 13, color: '#4b5563', margin: '0 0 10px' }}>{info.intro}</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button small onClick={() => void download()} disabled={busy !== null}>{busy === 'download' ? T.downloading : T.download}</Button>
        <label htmlFor={inputId} style={{ fontSize: 13, color: '#4b5563' }}>{T.pickFile}</label>
        <input
          id={inputId}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={pick}
          disabled={busy !== null}
          style={{ fontSize: 13, maxWidth: 220 }}
        />
      </div>
      <p style={{ fontSize: 13, margin: '8px 0' }} aria-live="polite">{file ? T.fileInfo(file.name, file.size) : T.noFile}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button small onClick={() => void preview()} disabled={!file || busy !== null}>{busy === 'preview' ? T.checking : T.check}</Button>
        <Button small variant="primary" onClick={() => setConfirming(true)} disabled={!ready || busy !== null}>{busy === 'commit' ? T.committing : T.commit}</Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {current ? <CheckResult result={current.result} rejected={current.rejected} /> : null}
      {done ? (
        <div role="status" style={{ marginTop: 10, background: '#e7f6ec', color: '#166534', borderRadius: 6, padding: '10px 12px', fontSize: 14 }}>
          {T.done(done.totalRows)}
          {can(...info.list.permission) ? <> <Link href={info.list.href}>{info.list.label}</Link></> : null}
          <CreatedList created={done.created} done />
        </div>
      ) : null}
      {confirming && current ? (
        <ConfirmDialog
          title={T.confirmTitle(info.title)}
          message={T.confirmBody(current.result.totalRows)}
          confirmLabel={T.commit}
          onConfirm={commit}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
}
