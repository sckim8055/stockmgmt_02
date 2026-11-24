'use client';
// 업로드 검사·반영 결과 표시.
import { Table, td } from '../../ui';
import type { ImportResult } from './labels';

const T = {
  rows: (n: number) => `자료 ${n.toLocaleString('ko-KR')}행`,
  previewClean: (n: number) => `검사를 마쳤습니다. 오류가 없습니다. ${n.toLocaleString('ko-KR')}행을 반영할 수 있습니다.`,
  hasErrors: (n: number) => `오류 ${n.toLocaleString('ko-KR')}건이 있어 반영할 수 없습니다. 파일을 고친 뒤 다시 골라 검사하세요.`,
  commitRejected: '반영하지 못했습니다. 검사한 뒤 자료가 바뀌어 아래 오류가 생겼습니다. 아무것도 반영되지 않았습니다.',
  errorsCapped: '오류는 처음 200건까지만 표시합니다.',
  createdTitlePreview: '반영하면 자동으로 만들 기준 정보',
  createdTitleDone: '자동으로 만든 기준 정보',
  createdNone: '자동으로 만들 기준 정보가 없습니다.',
  departments: '부서',
  categories: '카테고리',
  models: '모델',
  colRow: '행',
  colMessage: '오류 내용',
  errorCaption: '행 번호는 엑셀의 행 번호입니다(머리글이 1행).',
};

const ERROR_CAP = 200;

export function CreatedList({ created, done }: { created: ImportResult['created']; done: boolean }) {
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
