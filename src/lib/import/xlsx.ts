// 엑셀(.xlsx) 읽기·쓰기. 업로드 양식에 필요한 만큼만 직접 구현한다.
//
// 범용 엑셀 라이브러리를 쓰지 않는 이유: 외부에서 받은 파일을 서버에서 여는 코드라 공격 표면을 작게 유지한다.
// npm 의 `xlsx`(SheetJS)는 알려진 취약점이 고쳐지지 않은 판이 올라와 있고, 다른 라이브러리는 의존성이 크다.
//
// 이 파일이 지키는 것(모두 tests/review3.test.ts 로 확인한다)
//  - 파일이 스스로 적어 둔 크기·항목 수를 믿지 않는다. zip 목록을 직접 읽어 검사하고, 필요한 항목 넷(통합 문서, 관계,
//    공유 문자열, 첫 시트)만 푼다. 압축은 흘려 풀면서 실제로 나온 바이트를 세고, 한도를 넘는 순간 멈춘다.
//  - zip64, 암호화, 같은 이름이 둘 이상인 항목, 목록 항목이 지나치게 많은 파일은 거부한다.
//  - XML 은 앞에서 뒤로 한 번만 훑는다(정규식으로 닫는 태그를 찾지 않는다). 걸리는 시간이 입력 크기에 비례한다.
//  - DOCTYPE 이 있으면 거부한다. 엔티티는 표준 5종과 숫자 참조만 푼다(XXE·엔티티 폭탄이 통하지 않는다).
//  - 수식·서식·매크로·외부 연결은 읽지 않는다(수식 셀은 저장된 결과 값만 읽는다).
import { Inflate, strToU8, zipSync } from 'fflate';

export class XlsxError extends Error {}

export type Cell = string | number | boolean | null;

export const XLSX_LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  /** zip 목록의 항목 수. 보통의 엑셀 파일은 수십 개다. */
  zipEntries: 2000,
  /** 풀어낸 뒤의 크기 한도(실제로 나온 바이트 기준) */
  smallPartBytes: 1024 * 1024, // 통합 문서, 관계
  partBytes: 16 * 1024 * 1024, // 공유 문자열, 시트
  rows: 2001, // 머리글 1행 + 자료 2000행
  columns: 40,
  cellChars: 1000,
  sharedStrings: 200_000,
} as const;

const decoder = new TextDecoder('utf-8');
const NOT_XLSX = '파일을 열 수 없습니다. 엑셀(.xlsx) 형식으로 다시 저장해 주세요.';

// ─────────────────────────── zip ───────────────────────────

interface ZipEntry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** zip 의 목록(중앙 디렉터리)을 읽는다. 내용은 풀지 않는다. */
function readDirectory(bytes: Uint8Array): { entries: Map<string, ZipEntry>; directoryOffset: number } {
  // 끝 기록(EOCD)은 파일 끝에서 최대 22 + 65535 바이트 안에 있다.
  let eocd = -1;
  for (let i = bytes.length - 22, stop = Math.max(0, bytes.length - 22 - 65535); i >= stop; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError(NOT_XLSX);
  const count = u16(bytes, eocd + 10);
  const size = u32(bytes, eocd + 12);
  const offset = u32(bytes, eocd + 16);
  const zip64 = count === 0xffff || size === 0xffffffff || offset === 0xffffffff || (eocd >= 20 && u32(bytes, eocd - 20) === 0x07064b50);
  if (zip64 || count > XLSX_LIMITS.zipEntries || offset + size > eocd) throw new XlsxError(NOT_XLSX);

  const entries = new Map<string, ZipEntry>();
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || u32(bytes, p) !== 0x02014b50) throw new XlsxError(NOT_XLSX);
    const flags = u16(bytes, p + 8);
    const nameLength = u16(bytes, p + 28);
    const next = p + 46 + nameLength + u16(bytes, p + 30) + u16(bytes, p + 32);
    if (next > eocd) throw new XlsxError(NOT_XLSX);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)).toLowerCase();
    // 같은 이름(대소문자만 다른 것 포함)이 둘이면 어느 것이 읽힐지 프로그램마다 달라진다. 거부한다.
    if (entries.has(name)) throw new XlsxError(NOT_XLSX);
    entries.set(name, { method: (flags & 1) !== 0 ? -1 : u16(bytes, p + 10), compressedSize: u32(bytes, p + 20), localOffset: u32(bytes, p + 42) });
    p = next;
  }
  return { entries, directoryOffset: offset };
}

/** 항목 하나를 푼다. 실제로 나온 크기가 limit 를 넘으면 그 자리에서 멈춘다. */
function extract(bytes: Uint8Array, dir: { entries: Map<string, ZipEntry>; directoryOffset: number }, name: string, limit: number): string | null {
  // 파일 안의 이름은 대소문자를 구분하지 않는다(엑셀도 그렇게 연다). 목록의 열쇠는 소문자로 맞춰 두었다.
  const entry = dir.entries.get(name.toLowerCase());
  if (!entry) return null;
  const at = entry.localOffset;
  if (at + 30 > dir.directoryOffset || u32(bytes, at) !== 0x04034b50) throw new XlsxError(NOT_XLSX);
  const start = at + 30 + u16(bytes, at + 26) + u16(bytes, at + 28);
  const end = start + entry.compressedSize;
  if (end > dir.directoryOffset) throw new XlsxError(NOT_XLSX);
  const data = bytes.subarray(start, end);
  const tooBig = () => new XlsxError('파일 내용이 너무 큽니다.');
  if (entry.method === 0) {
    if (data.length > limit) throw tooBig();
    return decoder.decode(data);
  }
  if (entry.method !== 8) throw new XlsxError(NOT_XLSX); // 암호화 또는 지원하지 않는 압축
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflate = new Inflate((chunk) => {
    total += chunk.length;
    if (total > limit) throw tooBig();
    chunks.push(chunk);
  });
  try {
    // 조금씩 넣어, 한도를 넘는 순간 나머지 입력을 풀지 않고 멈춘다. 압축은 최대 약 1,000배로 불어나므로
    // 한 번에 넣는 양이 곧 한도를 넘겨 풀리는 양의 상한이다(2KB → 약 2MB).
    const STEP = 2 * 1024;
    for (let i = 0; i < data.length; i += STEP) inflate.push(data.subarray(i, Math.min(i + STEP, data.length)), i + STEP >= data.length);
    if (data.length === 0) inflate.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof XlsxError) throw err;
    throw new XlsxError(NOT_XLSX);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return decoder.decode(out);
}

// ─────────────────────────── XML ───────────────────────────

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

interface XmlHandler {
  /** name 은 접두사(x:)를 뗀 이름, attrs 는 태그 안의 나머지 글자 그대로 */
  open(name: string, attrs: string, selfClosing: boolean): void;
  close(name: string): void;
  /** 글자 구간 [from, to). 필요할 때만 잘라 쓰도록 위치로 알려 준다. escaped 면 엔티티를 풀어야 한다. */
  text(xml: string, from: number, to: number, escaped: boolean): void;
}

/** 글자 구간을 꺼낸다. 셀 한도를 훨씬 넘는 글은 앞부분만 꺼낸다(어차피 한도 초과로 거부된다). */
function textOf(xml: string, from: number, to: number, escaped: boolean): string {
  const raw = xml.slice(from, Math.min(to, from + XLSX_LIMITS.cellChars * 10));
  return escaped ? unescapeXml(raw) : raw;
}

const localName = (name: string) => {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
};

/**
 * XML 을 앞에서 뒤로 한 번 훑으며 태그와 글자를 알려 준다. 모든 글자를 정해진 횟수만 보므로 시간은 길이에 비례한다.
 * 형식이 깨진(닫히지 않은) 입력은 오류로 끝낸다.
 */
function scanXml(xml: string, h: XmlHandler): void {
  const broken = () => new XlsxError(NOT_XLSX);
  let pos = 0;
  for (;;) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) break;
    if (lt > pos) h.text(xml, pos, lt, true);
    const c = xml.charCodeAt(lt + 1);
    if (c === 33 /* ! */) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        if (end < 0) throw broken();
        pos = end + 3;
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9);
        if (end < 0) throw broken();
        h.text(xml, lt + 9, end, false);
        pos = end + 3;
      } else throw broken(); // DOCTYPE 등. 엑셀 파일에는 없다.
      continue;
    }
    if (c === 63 /* ? */) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw broken();
      pos = end + 2;
      continue;
    }
    // 태그의 끝을 찾는다. 속성 값(따옴표 안)의 '>' 는 건너뛴다.
    let gt = -1;
    let quote = 0;
    for (let i = lt + 1; i < xml.length; i++) {
      const ch = xml.charCodeAt(i);
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 || ch === 39) quote = ch;
      else if (ch === 62) {
        gt = i;
        break;
      } else if (ch === 60) throw broken();
    }
    if (gt < 0) throw broken();
    pos = gt + 1;
    if (c === 47 /* / */) {
      h.close(localName(xml.slice(lt + 2, gt).trim()));
      continue;
    }
    const selfClosing = xml.charCodeAt(gt - 1) === 47;
    const body = xml.slice(lt + 1, selfClosing ? gt - 1 : gt);
    let nameEnd = 0;
    while (nameEnd < body.length && body.charCodeAt(nameEnd) > 32) nameEnd++;
    h.open(localName(body.slice(0, nameEnd)), body.slice(nameEnd), selfClosing);
  }
}

/**
 * 태그의 속성들을 읽는다. 큰따옴표·작은따옴표, `=` 앞뒤의 공백을 모두 받는다. 글자를 한 번씩만 본다.
 * 속성 이름은 접두사를 포함한 그대로다(r:id 등).
 */
function parseAttrs(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = attrs.length;
  let i = 0;
  while (i < n) {
    while (i < n && attrs.charCodeAt(i) <= 32) i++;
    const nameStart = i;
    while (i < n && attrs.charCodeAt(i) > 32 && attrs.charCodeAt(i) !== 61) i++;
    const name = attrs.slice(nameStart, i);
    while (i < n && attrs.charCodeAt(i) <= 32) i++;
    if (!name || attrs.charCodeAt(i) !== 61) throw new XlsxError(NOT_XLSX);
    i++;
    while (i < n && attrs.charCodeAt(i) <= 32) i++;
    const quote = attrs.charCodeAt(i);
    if (quote !== 34 && quote !== 39) throw new XlsxError(NOT_XLSX);
    const end = attrs.indexOf(quote === 34 ? '"' : "'", i + 1);
    if (end < 0) throw new XlsxError(NOT_XLSX);
    if (!out.has(name)) out.set(name, unescapeXml(attrs.slice(i + 1, end)));
    i = end + 1;
  }
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length && i < 4; i++) {
    const code = ref.charCodeAt(i) & ~32; // 소문자도 받는다
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  let phonetic = 0;
  let inText = false;
  scanXml(xml, {
    open(name, _attrs, selfClosing) {
      if (name === 'si') {
        if (out.length >= XLSX_LIMITS.sharedStrings) throw new XlsxError('파일 내용이 너무 큽니다.');
        if (selfClosing) out.push('');
        else current = '';
      } else if (name === 'rPh' && !selfClosing) phonetic++; // 발음 표기는 버린다
      else if (name === 't' && !selfClosing) inText = true;
    },
    close(name) {
      if (name === 'si') {
        out.push(current ?? '');
        current = null;
        phonetic = 0;
      } else if (name === 'rPh') phonetic = Math.max(0, phonetic - 1);
      else if (name === 't') inText = false;
    },
    text(xml, from, to, escaped) {
      // 한도를 넘는 글은 더 모으지 않는다(셀에서 쓰일 때 오류로 알린다).
      if (inText && phonetic === 0 && current !== null && current.length <= XLSX_LIMITS.cellChars) current += textOf(xml, from, to, escaped);
    },
  });
  if (current !== null) throw new XlsxError(NOT_XLSX); // 글자 목록이 닫히지 않은 채 끝났다
  return out;
}

function readSheet(xml: string, shared: string[]): Cell[][] {
  const rows: Cell[][] = [];
  let rowCount = 0;
  let nextRow = 0;
  let rowIndex = -1;
  let cells: Cell[] | null = null;
  let nextCol = 0;
  // 지금 읽는 셀
  let col = -1;
  let type = 'n';
  let value: string | null = null;
  let inline: string | null = null;
  let capture: 'v' | 't' | null = null;
  let phonetic = 0;

  const finishCell = () => {
    if (!cells || col < 0) return;
    let out: Cell = null;
    if (type === 'inlineStr') out = inline;
    else if (value === null || value === '') out = null;
    else if (type === 's') {
      const index = Number(value);
      // 가리키는 글이 없으면 빈 칸으로 넘기지 않고 멈춘다(조용히 값이 사라지면 안 된다).
      if (!Number.isInteger(index) || index < 0 || index >= shared.length) throw new XlsxError(`${rowIndex + 1}행: 파일의 글자 목록이 맞지 않습니다. 엑셀에서 다시 저장해 주세요.`);
      out = shared[index]!;
    } else if (type === 'str' || type === 'd') out = value;
    else if (type === 'b') out = value === '1';
    else if (type === 'e') out = null; // 수식 오류(#N/A 등)는 빈 값으로 본다
    else {
      const n = Number(value);
      out = Number.isFinite(n) ? n : null;
    }
    if (typeof out === 'string') {
      if (out.length > XLSX_LIMITS.cellChars) throw new XlsxError(`${rowIndex + 1}행: 셀의 글자 수가 너무 많습니다.`);
      if (out.trim() === '') out = null;
    }
    if (col >= XLSX_LIMITS.columns) {
      // 양식보다 오른쪽의 빈 서식 셀은 무시하고, 값이 있으면 거부한다.
      if (out !== null) throw new XlsxError(`열이 너무 많습니다. (최대 ${XLSX_LIMITS.columns}열)`);
    } else {
      while (cells.length < col) cells.push(null);
      if (col < cells.length) throw new XlsxError(`${rowIndex + 1}행: 같은 칸이 두 번 들어 있습니다.`);
      cells[col] = out;
    }
    col = -1;
  };

  scanXml(xml, {
    open(name, attrs, selfClosing) {
      if (name === 'row') {
        // 한도는 실제로 읽은 행의 수로 센다(r 속성은 파일이 적은 값이라 믿지 않는다).
        if (++rowCount > XLSX_LIMITS.rows) throw new XlsxError(`행이 너무 많습니다. (한 번에 최대 ${XLSX_LIMITS.rows - 1}행)`);
        const r = Number(parseAttrs(attrs).get('r'));
        rowIndex = Number.isInteger(r) && r >= 1 ? r - 1 : nextRow;
        if (rowIndex < nextRow) throw new XlsxError(`${rowIndex + 1}행: 행 번호가 겹치거나 순서가 맞지 않습니다.`);
        if (rowIndex >= XLSX_LIMITS.rows) throw new XlsxError(`행이 너무 많습니다. (한 번에 최대 ${XLSX_LIMITS.rows - 1}행)`);
        nextRow = rowIndex + 1;
        cells = [];
        nextCol = 0;
        if (selfClosing) {
          while (rows.length < rowIndex) rows.push([]);
          rows[rowIndex] = cells;
          cells = null;
        }
      } else if (name === 'c' && cells) {
        if (col >= 0) throw new XlsxError(NOT_XLSX); // 칸 안에 칸
        const a = parseAttrs(attrs);
        const ref = a.get('r');
        col = ref ? columnIndex(ref) : nextCol;
        if (col < 0) throw new XlsxError(NOT_XLSX);
        nextCol = col + 1;
        type = a.get('t') ?? 'n';
        value = null;
        inline = null;
        phonetic = 0;
        if (selfClosing) finishCell();
      } else if (col >= 0 && !selfClosing) {
        if (name === 'v') {
          capture = 'v';
          value = '';
        } else if (name === 'is') inline = '';
        else if (name === 'rPh') phonetic++;
        else if (name === 't' && inline !== null && phonetic === 0) capture = 't';
      }
    },
    close(name) {
      if (name === 'v' || name === 't') capture = null;
      else if (name === 'rPh') phonetic = Math.max(0, phonetic - 1);
      else if (name === 'c') finishCell();
      else if (name === 'row' && cells) {
        while (rows.length < rowIndex) rows.push([]);
        rows[rowIndex] = cells;
        cells = null;
      }
    },
    text(xml, from, to, escaped) {
      if (capture === 'v' && value !== null && value.length <= XLSX_LIMITS.cellChars) value += textOf(xml, from, to, escaped);
      else if (capture === 't' && inline !== null && inline.length <= XLSX_LIMITS.cellChars) inline += textOf(xml, from, to, escaped);
    },
  });
  // 행이나 칸이 닫히지 않은 채 끝났으면 파일이 잘린 것이다.
  if (cells !== null || col >= 0) throw new XlsxError(NOT_XLSX);
  return rows;
}

/** 첫 시트의 경로를 찾는다(통합 문서의 첫 <sheet> → 관계 파일의 Target). */
function firstSheetPath(workbook: string | null, rels: string | null): string {
  let rid: string | undefined;
  if (workbook) {
    scanXml(workbook, {
      open(name, attrs) {
        if (name === 'sheet' && rid === undefined) {
          const a = parseAttrs(attrs);
          rid = a.get('r:id') ?? a.get('id') ?? '';
        }
      },
      close() {},
      text() {},
    });
  }
  let path: string | undefined;
  if (rels && rid) {
    scanXml(rels, {
      open(name, attrs) {
        const a = name === 'Relationship' && path === undefined ? parseAttrs(attrs) : null;
        if (a && a.get('Id') === rid) {
          const target = a.get('Target');
          if (target) path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
        }
      },
      close() {},
      text() {},
    });
  }
  path ??= 'xl/worksheets/sheet1.xml';
  if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(path)) throw new XlsxError(NOT_XLSX);
  return path;
}

/** 첫 시트를 행·열 배열로 읽는다. 빈 행은 건너뛰지 않고 그대로 둔다(행 번호를 엑셀과 맞추기 위해). */
export function readXlsx(bytes: Uint8Array): Cell[][] {
  if (bytes.length > XLSX_LIMITS.fileBytes) throw new XlsxError('파일이 너무 큽니다. (최대 5MB)');
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new XlsxError('엑셀(.xlsx) 파일이 아닙니다.');
  const dir = readDirectory(bytes);
  const sheetPath = firstSheetPath(
    extract(bytes, dir, 'xl/workbook.xml', XLSX_LIMITS.smallPartBytes),
    extract(bytes, dir, 'xl/_rels/workbook.xml.rels', XLSX_LIMITS.smallPartBytes),
  );
  const sheet = extract(bytes, dir, sheetPath, XLSX_LIMITS.partBytes);
  if (sheet === null) throw new XlsxError('시트를 찾을 수 없습니다. 엑셀(.xlsx) 파일이 맞는지 확인하세요.');
  const sharedXml = extract(bytes, dir, 'xl/sharedStrings.xml', XLSX_LIMITS.partBytes);
  return readSheet(sheet, sharedXml === null ? [] : readSharedStrings(sharedXml));
}

/**
 * 엑셀 날짜 일련번호(1900 날짜 체계) → YYYY-MM-DD.
 * 엑셀은 실제로 없는 1900-02-29 를 60번으로 세므로, 그 앞(1~59)은 하루를 더해 맞추고 60은 받지 않는다.
 */
export function serialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const day = Math.floor(serial);
  if (day === 60) return null;
  const ms = Date.UTC(1899, 11, 30) + (day < 60 ? day + 1 : day) * 86400000;
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
