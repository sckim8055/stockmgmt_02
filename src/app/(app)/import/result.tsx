'use client';
// 업로드 검사·반영 결과 표시.
import { Table, td } from '../../ui';
import type { ImportResult } from './labels';
import { useT } from '../../i18n';
import { TEXT } from './result.text';

const ERROR_CAP = 200;

export function CreatedList({ created, done }: { created: ImportResult['created']; done: boolean }) {
  const T = useT(TEXT);
  const groups: [string, string[]][] = [
    [T.departments, created.departments],
    [T.categories, created.categories],
    [T.models, created.models],
  ];
  const hasAny = groups.some(([, names]) => names.length > 0);
  if (!hasAny) return done ? null : <p style={{ fontSize: 13, color: '#6b7280', margin: '6px 0' }}>{T.createdNone}</p>;
  return (
    <div style={{ fontSize: 13, margin: '6px 0' }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{done ? T.createdTitleDone : T.createdTitlePreview}</div>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 10px' }}>
        {groups.filter(([, names]) => names.length > 0).map(([label, names]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt style={{ color: '#6b7280' }}>{label} ({names.length})</dt>
            <dd style={{ margin: 0 }}>{names.join(', ')}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 검사 결과 또는 반영 거부(422) 결과 */
export function CheckResult({ result, rejected }: { result: ImportResult; rejected: boolean }) {
  const T = useT(TEXT);
  const errors = result.errors;
  const clean = errors.length === 0;
  return (
    <div style={{ marginTop: 10 }}>
      <p role="status" style={{ fontSize: 14, margin: '0 0 4px', color: clean ? '#166534' : '#b91c1c' }}>
        {rejected ? T.commitRejected : clean ? T.previewClean(result.totalRows) : T.hasErrors(errors.length)}
      </p>
      <p style={{ fontSize: 13, color: '#4b5563', margin: '0 0 4px' }}>{T.rows(result.totalRows)}</p>
      {clean ? <CreatedList created={result.created} done={false} /> : null}
      {errors.length > 0 ? (
        <>
          <Table caption={T.errorCaption} head={[T.colRow, T.colMessage]}>
            {errors.map((e, i) => (
              <tr key={`${e.row}-${i}`}>
                <td style={{ ...td, width: 60, textAlign: 'right' }}>{e.row}</td>
                <td style={td}>{e.message}</td>
              </tr>
            ))}
          </Table>
          {errors.length >= ERROR_CAP ? <p style={{ fontSize: 12, color: '#6b7280' }}>{T.errorsCapped}</p> : null}
        </>
      ) : null}
    </div>
  );
}
