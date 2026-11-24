// 업로드 라우트 세 개가 함께 쓰는 요청·응답 처리.
import type { Db } from '@/lib/db/context';
import { badRequest, HttpError, json } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { IMPORT_COLUMNS, IMPORT_TITLES, runImport, type ImportKind } from './run';
import { readXlsx, writeXlsx, XLSX_LIMITS, XlsxError } from './xlsx';

/** 요청 본문(엑셀 파일 그대로)을 크기를 확인하며 읽는다. */
async function readUpload(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > XLSX_LIMITS.fileBytes) throw new HttpError(413, 'TOO_LARGE', '파일이 너무 큽니다. (최대 5MB)');
  if (!req.body) throw badRequest('파일이 없습니다.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > XLSX_LIMITS.fileBytes) {
      await reader.cancel();
      throw new HttpError(413, 'TOO_LARGE', '파일이 너무 큽니다. (최대 5MB)');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}

/** POST: ?mode=preview(기본) 는 검사만, ?mode=commit 은 반영. 오류가 있으면 아무것도 반영하지 않는다. */
export async function handleImport(kind: ImportKind, req: Request, actor: Actor, tenant: <T>(fn: (db: Db) => Promise<T>) => Promise<T>): Promise<Response> {
  const mode = new URL(req.url).searchParams.get('mode') ?? 'preview';
  if (mode !== 'preview' && mode !== 'commit') throw badRequest('mode 는 preview 또는 commit 이어야 합니다.');
  const bytes = await readUpload(req);
  let sheet;
  try {
    sheet = readXlsx(bytes);
  } catch (err) {
    if (err instanceof XlsxError) throw badRequest(err.message);
    throw err;
  }
  const result = await runImport(tenant, actor, kind, sheet, { commit: mode === 'commit' });
  // 반영을 요청했는데 오류로 반영하지 못했으면 422.
  return json(result, { status: mode === 'commit' && !result.committed ? 422 : 200 });
}

/** GET: 빈 양식 내려받기. 첫 시트가 입력용, 둘째 시트가 안내다. */
export function templateResponse(kind: ImportKind): Response {
  const columns = IMPORT_COLUMNS[kind];
  const bytes = writeXlsx([
    { name: IMPORT_TITLES[kind], rows: [columns.map((c) => (c.required ? `${c.header}*` : c.header))] },
    {
      name: '작성 안내',
      rows: [
        ['열', '필수', '설명'],
        ...columns.map((c) => [c.header, c.required ? '필수' : '', c.hint]),
        [],
        ['첫 번째 시트의 2행부터 입력합니다. 머리글(1행)은 바꾸지 마세요. 한 번에 최대 2,000행까지 올릴 수 있습니다.'],
        ['한 행이라도 오류가 있으면 전체가 반영되지 않습니다. 오류를 고친 뒤 다시 올려 주세요.'],
      ],
    },
  ]);
  return new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="import-${kind}.xlsx"`,
      'cache-control': 'no-store',
    },
  });
}
