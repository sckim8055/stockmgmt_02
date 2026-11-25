'use client';
// 업로드 검사·반영 결과 표시.
import { Table, td } from '../../ui';
import { useKindText, type ImportResult } from './labels';
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
  if (!hasAny) return done ? null : <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '6px 0' }}>{T.createdNone}</p>;
  return (
    <div style={{ fontSize: 13, margin: '6px 0' }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{done ? T.createdTitleDone : T.createdTitlePreview}</div>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 10px' }}>
        {groups.filter(([, names]) => names.length > 0).map(([label, names]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--text-muted)' }}>{label} ({names.length})</dt>
            <dd style={{ margin: 0 }}>{names.join(', ')}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 통합 파일 업로드의 시트별 행 수 */
export function SheetSummary({ sheets }: { sheets: NonNullable<ImportResult['sheets']> }) {
  const T = useT(TEXT);
  const kindText = useKindText();
  if (sheets.length === 0) return null;
  return (
    <div style={{ fontSize: 13, margin: '6px 0' }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{T.sheetsTitle}</div>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {sheets.map((s) => (
          <li key={s.sheet}>
            {T.sheetLabel(s.sheet, kindText[s.kind].title)}: {s.skipped ? T.sheetSkipped : T.sheetRows(s.totalRows)}
          </li>
        ))}
      </ul>
    </div>
  );
}

type RowErr = ImportResult['errors'][number];

function ErrorTable({ caption, errors }: { caption: string; errors: RowErr[] }) {
  const T = useT(TEXT);
  return (
    <Table caption={caption} head={[T.colRow, T.colMessage]}>
      {errors.map((e, i) => (
        <tr key={`${e.row}-${i}`}>
          <td style={{ ...td, width: 60, textAlign: 'right' }}>{e.row}</td>
          <td style={td}>{e.message}</td>
        </tr>
      ))}
    </Table>
  );
}

/** 오류를 시트별로 묶는다. 시트 이름이 없는 오류(파일 전체)는 맨 앞. 시트 순서는 서버가 처리한 순서(sheets)를 따른다. */
function groupBySheet(errors: RowErr[], sheets: NonNullable<ImportResult['sheets']>): { sheet: string | null; errors: RowErr[] }[] {
  const order = new Map<string | null, number>([[null, -1], ...sheets.map((s, i) => [s.sheet, i] as [string, number])]);
  const groups = new Map<string | null, RowErr[]>();
  for (const e of errors) {
    const key = e.sheet ?? null;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (order.get(a) ?? sheets.length) - (order.get(b) ?? sheets.length))
    .map(([sheet, errs]) => ({ sheet, errors: errs }));
}

/** 검사 결과 또는 반영 거부(422) 결과 */
export function CheckResult({ result, rejected }: { result: ImportResult; rejected: boolean }) {
  const T = useT(TEXT);
  const kindText = useKindText();
  const sheets = result.sheets;
  const errors = result.errors;
  const clean = errors.length === 0;
  return (
    <div style={{ marginTop: 10 }}>
      <p role="status" style={{ fontSize: 14, margin: '0 0 4px', color: clean ? 'var(--success-text)' : 'var(--danger-text)' }}>
        {rejected ? T.commitRejected : clean ? T.previewClean(result.totalRows) : T.hasErrors(errors.length)}
      </p>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 4px' }}>{T.rows(result.totalRows)}</p>
      {sheets ? <SheetSummary sheets={sheets} /> : null}
      {clean ? <CreatedList created={result.created} done={false} /> : null}
      {errors.length > 0 ? (
        <>
          {sheets
            ? groupBySheet(errors, sheets).map((g) => {
                const kind = sheets.find((s) => s.sheet === g.sheet)?.kind;
                const label = g.sheet === null ? T.fileErrors : T.sheetLabel(g.sheet, kind ? kindText[kind].title : g.sheet);
                return (
                  <section key={g.sheet ?? ''} aria-label={label} style={{ marginTop: 8 }}>
                    <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>{label} ({g.errors.length})</h3>
                    <ErrorTable caption={T.errorCaptionSheet(label)} errors={g.errors} />
                  </section>
                );
              })
            : <ErrorTable caption={T.errorCaption} errors={errors} />}
          {errors.length >= ERROR_CAP ? <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{T.errorsCapped}</p> : null}
        </>
      ) : null}
    </div>
  );
}
