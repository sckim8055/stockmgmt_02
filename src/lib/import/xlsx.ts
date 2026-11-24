// 엑셀(.xlsx) 읽기·쓰기. 업로드 양식에 필요한 만큼만 직접 구현한다.
//
// 범용 엑셀 라이브러리를 쓰지 않는 이유: 외부에서 받은 파일을 서버에서 여는 코드라 공격 표면을 작게 유지한다.
// npm 의 `xlsx`(SheetJS)는 알려진 취약점이 고쳐지지 않은 판이 올라와 있고, 다른 라이브러리는 의존성이 크다.
// 여기서는 압축 해제(fflate, 의존성 없음)만 외부 코드에 맡기고, 첫 시트의 셀 값만 읽는다.
//  - 수식·서식·매크로·외부 연결은 읽지 않는다(수식 셀은 저장된 결과 값만 읽는다).
//  - XML 엔티티는 표준 5종과 숫자 참조만 푼다(DOCTYPE 에 정의된 엔티티를 펼치지 않으므로 XXE·엔티티 폭탄이 통하지 않는다).
//  - 압축을 풀기 전에 항목별·전체 크기를 확인한다(압축 폭탄 방지).
import { strToU8, unzipSync, zipSync } from 'fflate';

export class XlsxError extends Error {}

export type Cell = string | number | boolean | null;

export const XLSX_LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  entryBytes: 40 * 1024 * 1024,
  totalBytes: 60 * 1024 * 1024,
  rows: 2001, // 머리글 1행 + 자료 2000행
  columns: 40,
  cellChars: 1000,
} as const;

const decoder = new TextDecoder('utf-8');

function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (_, name: string) => {
    switch (name) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
      }
    }
  });
}

/** <si> 또는 <is> 안의 글자를 모은다. 서식이 섞인 글(<r>)은 이어 붙이고, 발음 표기(<rPh>)는 버린다. */
function richText(xml: string): string {
  const body = xml.includes('<rPh') ? xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '') : xml;
  let out = '';
  for (const m of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += unescapeXml(m[1]!);
  return out;
}

const attr = (attrs: string, name: string): string | undefined => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/** 첫 시트의 XML 경로를 찾는다(workbook.xml 의 첫 <sheet> → 관계 파일의 Target). */
function firstSheetPath(files: Record<string, Uint8Array>): string {
  const workbook = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (workbook && rels) {
    const sheet = /<sheet\b([^>]*)\/?>/.exec(decoder.decode(workbook));
    const rid = sheet ? attr(sheet[1]!, 'r:id') : undefined;
    if (rid) {
      for (const m of decoder.decode(rels).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        if (attr(m[1]!, 'Id') === rid) {
          const target = attr(m[1]!, 'Target');
          if (target) {
            const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
            if (files[path]) return path;
          }
        }
      }
    }
  }
  if (files['xl/worksheets/sheet1.xml']) return 'xl/worksheets/sheet1.xml';
  throw new XlsxError('시트를 찾을 수 없습니다. 엑셀(.xlsx) 파일이 맞는지 확인하세요.');
}

/** 첫 시트를 행·열 배열로 읽는다. 완전히 빈 행은 건너뛰지 않고 그대로 둔다(행 번호를 엑셀과 맞추기 위해). */
export function readXlsx(bytes: Uint8Array): Cell[][] {
  if (bytes.length > XLSX_LIMITS.fileBytes) throw new XlsxError('파일이 너무 큽니다. (최대 5MB)');
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new XlsxError('엑셀(.xlsx) 파일이 아닙니다.');
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        const wanted = f.name === 'xl/workbook.xml' || f.name === 'xl/_rels/workbook.xml.rels' || f.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(f.name);
        if (!wanted) return false;
        total += f.originalSize;
        if (f.originalSize > XLSX_LIMITS.entryBytes || total > XLSX_LIMITS.totalBytes) throw new XlsxError('파일 내용이 너무 큽니다.');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof XlsxError) throw err;
    throw new XlsxError('파일을 열 수 없습니다. 엑셀(.xlsx) 형식으로 다시 저장해 주세요.');
  }

  const shared: string[] = [];
  if (files['xl/sharedStrings.xml']) {
    for (const m of decoder.decode(files['xl/sharedStrings.xml']).matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(m[1] ? richText(m[1]) : '');
  }

  const sheet = decoder.decode(files[firstSheetPath(files)]!);
  const rows: Cell[][] = [];
  let nextRow = 0;
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attr(rowMatch[1]!, 'r'));
    const rowIndex = Number.isInteger(r) && r >= 1 ? r - 1 : nextRow;
    if (rowIndex >= XLSX_LIMITS.rows) throw new XlsxError(`행이 너무 많습니다. (한 번에 최대 ${XLSX_LIMITS.rows - 1}행)`);
    nextRow = rowIndex + 1;
    const cells: Cell[] = [];
    let nextCol = 0;
    for (const c of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1]!, 'r');
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      if (col < 0) continue;
      if (col >= XLSX_LIMITS.columns) {
        // 양식보다 오른쪽의 빈 서식 셀은 무시하고, 값이 있으면 거부한다.
        if (c[2] && /<v>|<is>/.test(c[2])) throw new XlsxError(`열이 너무 많습니다. (최대 ${XLSX_LIMITS.columns}열)`);
        continue;
      }
      const type = attr(c[1]!, 't') ?? 'n';
      const inner = c[2] ?? '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value: Cell = null;
      if (type === 'inlineStr') value = richText(inner);
      else if (v === undefined) value = null;
      else if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'str' || type === 'd') value = unescapeXml(v);
      else if (type === 'b') value = v === '1';
      else if (type === 'e') value = null; // 수식 오류(#N/A 등)는 빈 값으로 본다
      else {
        const n = Number(v);
        value = Number.isFinite(n) ? n : null;
      }
      if (typeof value === 'string') {
        if (value.length > XLSX_LIMITS.cellChars) throw new XlsxError(`${rowIndex + 1}행: 셀의 글자 수가 너무 많습니다.`);
        if (value.trim() === '') value = null;
      }
      while (cells.length < col) cells.push(null);
      cells[col] = value;
    }
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = cells;
  }
  return rows;
}

/** 엑셀 날짜 일련번호(1900 날짜 체계) → YYYY-MM-DD. */
export function serialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ─────────────────────────── 쓰기(양식 내려받기용) ───────────────────────────

const escapeXml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);

function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function sheetXml(rows: string[][]): string {
  const body = rows
    .map((cells, r) => {
      const cs = cells.map((text, c) => `<c r="${columnName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`).join('');
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** 글자만 든 시트들로 .xlsx 를 만든다. 첫 시트가 업로드할 때 읽히는 시트다. */
export function writeXlsx(sheets: { name: string; rows: string[][] }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        '</Relationships>',
    ),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows));
  });
  return zipSync(files, { level: 6 });
}
