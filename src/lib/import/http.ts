// 업로드 라우트 세 개가 함께 쓰는 요청·응답 처리.
import type { Db } from '@/lib/db/context';
import { badRequest, HttpError, json } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { IMPORT_COLUMNS, IMPORT_TITLES, runImport, type ImportKind } from './run';
import { readXlsx, writeXlsx, XLSX_LIMITS, XlsxError } from './xlsx';

/** 본문을 다 받기까지 기다리는 시간. 일부러 천천히 보내는 요청이 자리를 오래 차지하지 못하게 한다. */
const UPLOAD_DEADLINE_MS = 30_000;

/** 요청 본문(엑셀 파일 그대로)을 크기와 시간을 확인하며 읽는다. */
async function readUpload(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > XLSX_LIMITS.fileBytes) throw new HttpError(413, 'TOO_LARGE', '파일이 너무 큽니다. (최대 5MB)');
  if (!req.body) throw badRequest('파일이 없습니다.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + UPLOAD_DEADLINE_MS;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
    });
    const next = await Promise.race([reader.read(), timeout]);
    clearTimeout(timer);
    if (next === 'timeout') {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(408, 'UPLOAD_TIMEOUT', '파일을 받는 데 너무 오래 걸렸습니다. 다시 시도하세요.');
    }
    const { done, value } = next;
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

// 동시에 받고 있는 업로드 본문 수의 상한. 본문은 다 받을 때까지 메모리에 쌓이므로(건당 최대 5MB, 30초),
// 상한이 없으면 여러 요청이 본문을 조금씩 보내며 메모리를 붙잡을 수 있다. 넘으면 본문을 읽기 전에 거절한다.
const MAX_INFLIGHT_UPLOADS = 2;
let inflightUploads = 0;

// 한 프로세스에서 동시에 처리하는 업로드 수. 업로드는 파일을 푸는 동안 다른 요청을 멈추게 하고(동기 처리),
// 처리하는 동안 DB 연결 하나를 오래 잡는다. 여러 건이 겹쳐 서비스 전체가 느려지지 않도록 하나씩만 받는다.
const MAX_CONCURRENT_IMPORTS = 1;
let runningImports = 0;

/** POST: ?mode=preview(기본) 는 검사만, ?mode=commit 은 반영. 오류가 있으면 아무것도 반영하지 않는다. */
export async function handleImport(kind: ImportKind, req: Request, actor: Actor, tenant: <T>(fn: (db: Db) => Promise<T>) => Promise<T>): Promise<Response> {
  const mode = new URL(req.url).searchParams.get('mode') ?? 'preview';
  if (mode !== 'preview' && mode !== 'commit') throw badRequest('mode 는 preview 또는 commit 이어야 합니다.');
  // 파일은 자리를 잡기 전에 다 받는다. 받는 동안에는 자리를 차지하지 않는다(느린 전송으로 다른 기업의 업로드를 막지 못하게).
  if (inflightUploads >= MAX_INFLIGHT_UPLOADS) throw new HttpError(429, 'IMPORT_BUSY', '업로드 요청이 몰려 있습니다. 잠시 후 다시 시도하세요.');
  inflightUploads++;
  let bytes: Uint8Array;
  try {
    bytes = await readUpload(req);
  } finally {
    inflightUploads--;
  }
  if (runningImports >= MAX_CONCURRENT_IMPORTS) throw new HttpError(429, 'IMPORT_BUSY', '다른 업로드가 처리 중입니다. 잠시 후 다시 시도하세요.');
  runningImports++;
  try {
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
  } finally {
    runningImports--;
  }
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
