// 업로드 라우트(직원·자산·주변기기, 통합 파일)가 함께 쓰는 요청·응답 처리.
import type { Db } from '@/lib/db/context';
import { badRequest, HttpError, json } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { ASSET_STATUS_VALUES, IMPORT_COLUMNS, IMPORT_TITLES, runImport, runWorkbookImport, WORKBOOK_MAX_ROWS, WORKBOOK_SHEETS, type ImportKind } from './run';
import { readXlsx, readXlsxSheets, writeXlsx, XLSX_LIMITS, XLSX_MULTI_LIMITS, XlsxError, type Cell } from './xlsx';

/** 본문을 다 받기까지 기다리는 시간. 일부러 천천히 보내는 요청이 자리를 오래 차지하지 못하게 한다. */
const UPLOAD_DEADLINE_MS = 30_000;
/** 자료가 이만큼 오지 않으면 끊는다(연결만 열어 두고 보내지 않는 요청). */
const UPLOAD_STALL_MS = 5_000;

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
      timer = setTimeout(() => resolve('timeout'), Math.max(0, Math.min(UPLOAD_STALL_MS, deadline - Date.now())));
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

// 동시에 받고 있는 업로드 본문 수의 상한. 본문은 다 받을 때까지 메모리에 쌓이므로(건당 최대 5MB),
// 상한이 없으면 여러 요청이 본문을 조금씩 보내며 메모리를 붙잡을 수 있다. 넘으면 본문을 읽기 전에 거절한다.
//  - 기업마다 1건: 한 기업이 자리를 여러 개 차지해 다른 기업의 업로드를 막지 못한다.
//  - 전체 8건: 메모리 상한(약 40MB).
//  - 보내지 않고 연결만 열어 둔 요청은 UPLOAD_STALL_MS 뒤에 끊긴다.
const MAX_INFLIGHT_UPLOADS = 8;
let inflightUploads = 0;
const inflightByCompany = new Set<string>();

// 한 프로세스에서 동시에 처리하는 업로드 수. 업로드는 파일을 푸는 동안 다른 요청을 멈추게 하고(동기 처리),
// 처리하는 동안 DB 연결 하나를 오래 잡는다. 여러 건이 겹쳐 서비스 전체가 느려지지 않도록 하나씩만 받는다.
const MAX_CONCURRENT_IMPORTS = 1;
let runningImports = 0;

/**
 * 업로드 요청의 공통 처리: mode 확인 → 수신 자리(기업마다 1, 전체 8) 안에서 본문 받기 → 처리 자리(프로세스당 1) 안에서
 * 파일 읽기(read)와 반영(process). 파일 읽기 오류(XlsxError)는 400 으로 바꾼다.
 * 반영을 요청했는데 오류로 반영하지 못했으면 422.
 */
async function withUpload<S, R extends { committed: boolean }>(
  req: Request,
  actor: Actor,
  read: (bytes: Uint8Array) => S,
  process: (sheet: S, commit: boolean) => Promise<R>,
): Promise<Response> {
  const mode = new URL(req.url).searchParams.get('mode') ?? 'preview';
  if (mode !== 'preview' && mode !== 'commit') throw badRequest('mode 는 preview 또는 commit 이어야 합니다.');
  // 파일은 자리를 잡기 전에 다 받는다. 받는 동안에는 자리를 차지하지 않는다(느린 전송으로 다른 기업의 업로드를 막지 못하게).
  if (inflightByCompany.has(actor.companyId)) throw new HttpError(429, 'IMPORT_BUSY', '이 기업의 다른 업로드를 받고 있습니다. 잠시 후 다시 시도하세요.');
  if (inflightUploads >= MAX_INFLIGHT_UPLOADS) throw new HttpError(429, 'IMPORT_BUSY', '업로드 요청이 몰려 있습니다. 잠시 후 다시 시도하세요.');
  inflightUploads++;
  inflightByCompany.add(actor.companyId);
  let bytes: Uint8Array;
  try {
    bytes = await readUpload(req);
  } finally {
    inflightUploads--;
    inflightByCompany.delete(actor.companyId);
  }
  if (runningImports >= MAX_CONCURRENT_IMPORTS) throw new HttpError(429, 'IMPORT_BUSY', '다른 업로드가 처리 중입니다. 잠시 후 다시 시도하세요.');
  runningImports++;
  try {
    let sheet: S;
    try {
      sheet = read(bytes);
    } catch (err) {
      if (err instanceof XlsxError) throw badRequest(err.message);
      throw err;
    }
    const result = await process(sheet, mode === 'commit');
    return json(result, { status: mode === 'commit' && !result.committed ? 422 : 200 });
  } finally {
    runningImports--;
  }
}

/** POST: ?mode=preview(기본) 는 검사만, ?mode=commit 은 반영. 오류가 있으면 아무것도 반영하지 않는다. */
export async function handleImport(kind: ImportKind, req: Request, actor: Actor, tenant: <T>(fn: (db: Db) => Promise<T>) => Promise<T>): Promise<Response> {
  return withUpload(req, actor, readXlsx, (sheet, commit) => runImport(tenant, actor, kind, sheet, { commit }));
}

/** POST(통합 파일): 직원·자산·주변기기 시트를 한 번에. 전송·크기·시간·동시 처리 제한은 종류별 업로드와 같다. */
export async function handleWorkbookImport(req: Request, actor: Actor, tenant: <T>(fn: (db: Db) => Promise<T>) => Promise<T>): Promise<Response> {
  const names = WORKBOOK_SHEETS.map((s) => s.sheet);
  return withUpload<Map<string, Cell[][]>, Awaited<ReturnType<typeof runWorkbookImport>>>(
    req,
    actor,
    (bytes) => readXlsxSheets(bytes, names),
    (sheets, commit) => runWorkbookImport(tenant, actor, sheets, { commit }),
  );
}

const xlsxResponse = (bytes: Uint8Array, fileName: string) =>
  new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'no-store',
    },
  });

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
        ...(kind === 'assets' ? [['사용자 지정 필드도 올릴 수 있습니다. 필드의 표시 이름(또는 키)을 머리글로 한 열을 오른쪽에 추가하세요. 필드는 기준 정보에서 먼저 만들어 두어야 합니다.']] : []),
      ],
    },
  ]);
  return xlsxResponse(bytes, `import-${kind}.xlsx`);
}

/** 작성 안내 시트에 싣는 예시(데이터 시트에는 넣지 않는다: 지우지 않고 올려도 들어가지 않게). 열 순서는 IMPORT_COLUMNS 와 같다. */
const WORKBOOK_EXAMPLES: Record<ImportKind, Record<string, string>> = {
  persons: { employeeNo: 'E1001', name: '홍길동', department: '총무팀', email: 'gildong.hong@example.com' },
  assets: {
    assetTag: 'NB-2024-001', category: '노트북', manufacturer: 'Lenovo', model: 'ThinkPad X1 Carbon', serialNumber: 'PF3ABCDE',
    department: 'IT', location: '본관 3층', holderEmployeeNo: 'E1001', purchaseDate: '2024-03-15', purchasePrice: '1850000',
    supplier: '(주)예시상사', warrantyEnd: '2027-03-14', status: '사용중',
  },
  peripherals: { category: '마우스', manufacturer: 'Logitech', model: 'M650', department: 'IT', qty: '20' },
};

const headerRow = (kind: ImportKind) => IMPORT_COLUMNS[kind].map((c) => (c.required ? `${c.header}*` : c.header));

/**
 * GET(통합 파일): 시트 순서는 작성 안내, 직원, 자산, 주변기기. 데이터 시트에는 머리글만 있고(종류별 양식과 같은 머리글),
 * 열 설명·예시·처리 순서·한도는 작성 안내 시트에 있다. 업로드할 때 작성 안내 시트는 읽지 않는다.
 */
export function workbookTemplateResponse(): Response {
  const n = (v: number) => v.toLocaleString('ko-KR');
  const order = WORKBOOK_SHEETS.map((s) => s.sheet).join(' → ');
  const guide: string[][] = [
    ['통합 업로드 양식 작성 안내'],
    [],
    [`직원·자산·주변기기를 한 파일로 올립니다. 필요한 시트에만 입력하고, 쓰지 않는 시트는 비워 두세요(머리글만 있는 시트는 건너뜁니다).`],
    [`처리 순서: ${order}. 자산 시트의 보유자사번에는 이 파일의 직원 시트에서 등록하는 직원의 사번도 쓸 수 있습니다.`],
    ['한 시트의 한 행이라도 오류가 있으면 모든 시트가 반영되지 않습니다(전부 아니면 전무). 오류를 고친 뒤 다시 올려 주세요.'],
    ['시트 이름(직원, 자산, 주변기기)과 각 시트의 머리글(1행)은 바꾸지 마세요. 2행부터 한 행에 하나씩 입력합니다. 이 안내 시트는 읽지 않습니다.'],
    [
      `한도: 파일 최대 5MB, 시트마다 최대 ${n(XLSX_LIMITS.rows - 1)}행이고 모든 시트를 합쳐 최대 ${n(WORKBOOK_MAX_ROWS)}행, 최대 ${XLSX_LIMITS.columns}열, 셀 하나 최대 ${n(XLSX_LIMITS.cellChars)}자. ` +
        `시트 내용은 모두 합쳐 최대 ${XLSX_MULTI_LIMITS.sheetBytesTotal / 1024 / 1024}MB(압축을 푼 크기)입니다.`,
    ],
    ['시트마다 그 종류를 올리는 권한이 필요합니다(직원 업로드·자산 업로드·주변기기 입고). 권한이 없는 시트가 있으면 아무것도 반영되지 않습니다.'],
    ['이미 등록된 자산 태그·사번은 오류로 처리합니다. 기존 자료를 고치지(덮어쓰지) 않습니다.'],
    ['자산 시트에는 사용자 지정 필드 열을 오른쪽에 추가할 수 있습니다. 필드의 표시 이름(또는 키)을 머리글로 적으세요. 필드는 기준 정보에서 먼저 만들어 두어야 합니다.'],
  ];
  for (const { kind, sheet } of WORKBOOK_SHEETS) {
    const columns = IMPORT_COLUMNS[kind];
    guide.push([], [`[${sheet}] 시트`], ['열', '필수', '설명', '예시']);
    for (const c of columns) guide.push([c.header, c.required ? '필수' : '', c.hint, WORKBOOK_EXAMPLES[kind][c.key] ?? '']);
    if (kind === 'assets') guide.push(['상태 열에 쓸 수 있는 값', '', `${ASSET_STATUS_VALUES.join(', ')} (비우면 재고, 보유자사번이 있으면 사용중)`]);
    guide.push([`예시 행(${sheet} 시트에 이렇게 입력합니다. 이 안내 시트의 예시는 올라가지 않습니다)`], headerRow(kind), columns.map((c) => WORKBOOK_EXAMPLES[kind][c.key] ?? ''));
  }
  const bytes = writeXlsx([
    { name: '작성 안내', rows: guide },
    ...WORKBOOK_SHEETS.map(({ kind, sheet }) => ({ name: sheet, rows: [headerRow(kind)] })),
  ]);
  return xlsxResponse(bytes, 'import-workbook.xlsx');
}
