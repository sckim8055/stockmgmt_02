// 3단계 독립 검토(review3): 결함 재현 테스트. 실패하는 테스트가 곧 지적 사항이다.
// 각 테스트 이름 앞의 [R3-x] 는 검토 보고서의 번호다. 조치 뒤에는 모두 통과해야 한다(docs/REVIEW-phase3.md).
import { strToU8, zipSync } from 'fflate';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as importAssets } from '@/app/api/import/assets/route';
import { POST as importPeripherals } from '@/app/api/import/peripherals/route';
import { POST as importPersons } from '@/app/api/import/persons/route';
import { POST as createPersonRoute } from '@/app/api/master/persons/route';
import { POST as adjustRoute } from '@/app/api/peripherals/adjust/route';
import { POST as issueRoute } from '@/app/api/peripherals/issue/route';
import { POST as receiveRoute } from '@/app/api/peripherals/receive/route';
import { GET as stockList } from '@/app/api/peripherals/route';
import { POST as assignRoute } from '@/app/api/assets/[id]/assign/route';
import { POST as retireRoute } from '@/app/api/assets/[id]/retire/route';
import { closePool } from '@/lib/db/pool';
import { IMPORT_COLUMNS } from '@/lib/import/run';
import { readXlsx, XlsxError } from '@/lib/import/xlsx';
import { call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};
type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
type Row = (string | number | null)[];
const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });
const one = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];
const post = (h: Handler, as: string, body: Record<string, unknown>) => call(h, { method: 'POST', cookie: cookie[as], body });

const WB = strToU8('<workbook><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>');
const RELS = strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
const rawSheet = (sheet: string, extra: Record<string, Uint8Array> = {}) =>
  zipSync({ 'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': strToU8(sheet), ...extra }, { level: 9 });

function xlsx(rows: Row[]): Uint8Array {
  const col = (i: number) => (i < 26 ? '' : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = rows
    .map((cells, r) => `<row r="${r + 1}">` + cells.map((v, c) =>
      v === null ? '' : typeof v === 'number' ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('') + '</row>')
    .join('');
  return rawSheet(`<worksheet><sheetData>${body}</sheetData></worksheet>`);
}

/** zip64 끝 레코드로 항목 수를 n 으로 속인 100바이트 남짓한 zip. 중앙 디렉터리에는 항목이 하나뿐이다. */
function zip64Count(n: bigint): Uint8Array {
  const base = zipSync({ 'a.txt': strToU8('hi') }, { level: 0 });
  const e = base.length - 22;
  const dv = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const cdOff = dv.getUint32(e + 16, true);
  const cdSize = dv.getUint32(e + 12, true);
  const head = base.subarray(0, e);
  const z64 = new Uint8Array(56);
  const zv = new DataView(z64.buffer);
  zv.setUint32(0, 0x06064b50, true);
  zv.setBigUint64(4, 44n, true);
  zv.setBigUint64(24, n, true);
  zv.setBigUint64(32, n, true);
  zv.setBigUint64(40, BigInt(cdSize), true);
  zv.setBigUint64(48, BigInt(cdOff), true);
  const loc = new Uint8Array(20);
  const lv = new DataView(loc.buffer);
  lv.setUint32(0, 0x07064b50, true);
  lv.setBigUint64(8, BigInt(head.length), true);
  lv.setUint32(16, 1, true);
  const eocd = base.slice(e);
  new DataView(eocd.buffer).setUint16(8, 0xffff, true);
  new DataView(eocd.buffer).setUint16(10, 0xffff, true);
  const out = new Uint8Array(head.length + 98);
  out.set(head, 0);
  out.set(z64, head.length);
  out.set(loc, head.length + 56);
  out.set(eocd, head.length + 76);
  return out;
}

function timed(fn: () => unknown): number {
  const t = performance.now();
  try {
    fn();
  } catch {
    /* 오류여도 시간만 잰다 */
  }
  return performance.now() - t;
}

async function upload(handler: Handler, as: string, file: Uint8Array, mode: 'preview' | 'commit' = 'commit') {
  const res = await handler(
    new Request(`http://app.test/api/import/x?mode=${mode}`, {
      method: 'POST',
      headers: { host: 'app.test', origin: 'http://app.test', cookie: cookie[as]!, 'content-type': 'application/octet-stream' },
      body: file as BodyInit,
    }),
  );
  return { status: res.status, data: await res.json() };
}

const H = {
  persons: IMPORT_COLUMNS.persons.map((c) => c.header),
  assets: IMPORT_COLUMNS.assets.map((c) => c.header),
  peripherals: IMPORT_COLUMNS.peripherals.map((c) => c.header),
};
const asset = (tag: string, over: Partial<Record<number, string | number | null>> = {}): Row => {
  const row: Row = [tag, 'Laptop', 'Lenovo', 'X1', null, null, null, null, null, null, null, null];
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v ?? null;
  return row;
};

async function userWith(c: TestCompany, loginId: string, acl: [string, string][] | string, deptIds: string[] = []): Promise<string> {
  const o = await owner();
  const userId = await makeUser(c.id, loginId, 'COMPANY_USER');
  let roleId: string;
  if (typeof acl === 'string') roleId = (await o.query('SELECT id FROM app.role WHERE company_id = $1 AND name = $2', [c.id, acl])).rows[0].id;
  else {
    roleId = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [c.id, uniq('role')])).rows[0].id;
    for (const [r, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [roleId, r, op]);
  }
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [userId, roleId, c.id]);
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [userId, d, c.id]);
  cookie[loginId] = await sessionFor(c.code, loginId);
  return userId;
}

beforeAll(async () => {
  A = await makeCompany('R3A');
  B = await makeCompany('R3B');
  const o = await owner();
  const q = async (sql: string, p: unknown[]) => (await o.query(sql, p)).rows[0].id as string;
  id.it = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A.id])).rows[0].id;
  id.hr = await q("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [A.id]);
  id.acat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [A.id]);
  id.pcat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Mouse') RETURNING id", [A.id]);
  id.laptop = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Lenovo', 'X1') RETURNING id", [A.id, id.acat]);
  id.p1 = await q("INSERT INTO app.person (company_id, name, employee_no) VALUES ($1, 'Kim', 'E-1') RETURNING id", [A.id]);
  id.p2 = await q("INSERT INTO app.person (company_id, name) VALUES ($1, 'Lee') RETURNING id", [A.id]);
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  await userWith(A, 'oper', 'Stock Operator');
  // 업로드 권한만 있고 등록(create) 권한은 없는 계정
  await userWith(A, 'importOnly', [['asset.item', 'read'], ['asset.item', 'import'], ['master.person', 'read'], ['master.person', 'import']]);
}, 120000);
afterAll(async () => {
  await closeOwner();
  await closePool();
});

// ─────────────────────────── 엑셀 읽기 ───────────────────────────

describe('[R3] 엑셀 읽기: 서버 이벤트 루프를 막는 입력', () => {
  it('[R3-1] 닫히지 않은 <row> 80,000개(압축 1.1KB)를 읽는 데 1초를 넘기지 않는다', () => {
    const file = rawSheet('<row>'.repeat(80_000));
    expect(file.length).toBeLessThan(2000);
    const ms = timed(() => readXlsx(file));
    console.log(`[R3-1] unclosed <row> x80000: zip ${file.length} B, ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1000);
  }, 120000);

  it('[R3-1b] 공유 문자열의 닫히지 않은 <si> 도 같다', () => {
    const file = rawSheet('<sheetData></sheetData>', { 'xl/sharedStrings.xml': strToU8('<sst>' + '<si>'.repeat(80_000)) });
    const ms = timed(() => readXlsx(file));
    console.log(`[R3-1b] unclosed <si> x80000: zip ${file.length} B, ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1000);
  }, 120000);

  it('[R3-2] zip64 항목 수를 2천만으로 속인 98바이트 zip 을 읽는 데 0.5초를 넘기지 않는다', () => {
    const file = zip64Count(20_000_000n);
    const ms = timed(() => readXlsx(file));
    console.log(`[R3-2] zip64 count 2e7: file ${file.length} B, ${ms.toFixed(0)} ms (2^32-1 => x215)`);
    expect(ms).toBeLessThan(500);
  }, 120000);

  it('[R3-2b] 실제 크기를 1바이트로 속인 항목(같은 압축 자료를 가리키는 중앙 디렉터리 항목 8개, 각 100MB)을 풀지 않는다', () => {
    // fflate 의 unzipSync 는 filter 에 originalSize(파일이 주장하는 값)만 넘기고, 그 크기의 버퍼를 만든 뒤
    // 압축 스트림을 끝까지 푼다(버퍼를 넘는 쓰기는 버려질 뿐 디코딩은 계속된다). 한도 검사가 실제 해제량을 막지 못한다.
    const kernel = deflateRawSync(Buffer.alloc(100 * 1024 * 1024, 0x20), { level: 9 });
    const n0 = Buffer.from('xl/worksheets/k.xml');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(kernel.length, 18); lh.writeUInt32LE(1, 22); lh.writeUInt16LE(n0.length, 26);
    const local = Buffer.concat([lh, n0, kernel]);
    const cds: Buffer[] = [];
    const N = 8;
    for (let i = 0; i < N; i++) {
      const nm = Buffer.from(`xl/worksheets/s${i}.xml`);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
      c.writeUInt32LE(kernel.length, 20); c.writeUInt32LE(1, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(0, 42);
      cds.push(c, nm);
    }
    const cd = Buffer.concat(cds);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(N, 8); eocd.writeUInt16LE(N, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(local.length, 16);
    const file = new Uint8Array(Buffer.concat([local, cd, eocd]));
    const ms = timed(() => readXlsx(file));
    console.log(`[R3-2b] understated originalSize: file ${file.length} B inflating ${N} x 100MB, ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(500);
  }, 120000);

  it('[R3-3] 행 번호(r)를 모두 1로 적으면 행 수 한도(2001)를 넘는 행도 읽는다', () => {
    const file = rawSheet('<sheetData>' + '<row r="1"><c r="A1"><v>1</v></c></row>'.repeat(5000) + '</sheetData>');
    expect(() => readXlsx(file)).toThrow(XlsxError);
  });
});

// ─────────────────────────── 업로드 ───────────────────────────

describe('[R3] 업로드: 잠금·연결 점유', () => {
  it('[R3-4] 한 기업이 업로드를 동시에 5건 보내도, 다른 기업의 요청은 연결 풀 고갈 없이 처리된다', async () => {
    // 2,000행 자산 업로드(보유자 배정 포함). 같은 기업의 업로드는 기업 잠금으로 한 줄로 서는데,
    // 기다리는 동안에도 각 요청이 DB 연결을 하나씩 잡고 있다(풀 기본 5개).
    const rows: Row[] = [H.assets];
    for (let i = 0; i < 2000; i++) rows.push(asset(uniq('DOS-'), { 7: 'E-1' }));
    const file = xlsx(rows);

    const t0 = performance.now();
    const single = await upload(importAssets as Handler, 'admin', file, 'preview');
    const singleMs = performance.now() - t0;
    console.log(`[R3-4] 2000-row asset preview (with holder): ${singleMs.toFixed(0)} ms, status ${single.status}`);
    expect(single.status).toBe(200);

    const imports = Array.from({ length: 5 }, () => upload(importAssets as Handler, 'admin', file, 'preview'));
    await new Promise((r) => setTimeout(r, 300));
    const t1 = performance.now();
    const other = await call(stockList as Handler, { path: '/api/peripherals', cookie: cookie.badmin });
    const otherMs = performance.now() - t1;
    const results = await Promise.all(imports);
    console.log(`[R3-4] company B GET /api/peripherals during 5 imports of A: status ${other.status}, ${otherMs.toFixed(0)} ms; import statuses ${results.map((r) => r.status).join(',')}`);
    expect(other.status).toBe(200);
    expect(otherMs).toBeLessThan(1000);
  }, 300000);
});

describe('[R3] 업로드: 권한·입력 검증', () => {
  it('[R3-5] 업로드(import) 권한만 있고 등록(create) 권한이 없으면 자산·직원을 만들 수 없다', async () => {
    const tag = uniq('IMP-');
    const a = await upload(importAssets as Handler, 'importOnly', xlsx([H.assets, asset(tag)]));
    const p = await upload(importPersons as Handler, 'importOnly', xlsx([H.persons, [uniq('N'), 'NoCreate', null, null]]));
    console.log(`[R3-5] import-only user: assets ${a.status} committed=${a.data.committed}, persons ${p.status} committed=${p.data.committed}`);
    expect(a.status).toBe(403);
    expect(p.status).toBe(403);
    expect((await one('SELECT count(*)::int AS n FROM app.asset WHERE company_id = $1 AND asset_tag = $2', [A.id, tag])).n).toBe(0);
  });

  it('[R3-6] 업로드는 화면 API와 같은 입력 규칙(이메일 형식, 사번 40자)을 적용한다', async () => {
    const api = await post(createPersonRoute as Handler, 'admin', { name: 'x', email: 'not-an-email' });
    expect(api.status).toBe(400);
    const apiNo = await post(createPersonRoute as Handler, 'admin', { name: 'x', employeeNo: 'N'.repeat(45) });
    expect(apiNo.status).toBe(400);
    const r = await upload(importPersons as Handler, 'admin', xlsx([H.persons, ['N'.repeat(45), 'Imported', null, 'not-an-email']]), 'preview');
    console.log(`[R3-6] import of email 'not-an-email' + 45-char 사번: status ${r.status}, errors ${JSON.stringify(r.data.errors)}`);
    expect(r.data.errors.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────── 주변기기 ───────────────────────────

async function freshStock(qty: number): Promise<{ stockId: string; modelId: string }> {
  const o = await owner();
  const modelId = (await o.query("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'T', $3) RETURNING id", [A.id, id.pcat, uniq('M')])).rows[0].id;
  const r = await post(receiveRoute as Handler, 'admin', { modelId, qty });
  expect(r.status).toBe(200);
  return { stockId: r.data.stockId, modelId };
}

async function invariants(stockId: string): Promise<string[]> {
  const o = await owner();
  const bad: string[] = [];
  const s = (await o.query('SELECT on_hand_qty, on_loan_qty FROM app.peripheral_stock WHERE id = $1', [stockId])).rows[0];
  const loans = (await o.query('SELECT id, qty, returned_qty, lost_qty, status FROM app.peripheral_loan WHERE stock_id = $1', [stockId])).rows;
  const tx = (await o.query('SELECT type, qty, loan_id FROM app.peripheral_txn WHERE stock_id = $1', [stockId])).rows as { type: string; qty: number; loan_id: string | null }[];
  const outstanding = loans.reduce((n, l) => n + l.qty - l.returned_qty - l.lost_qty, 0);
  if (s.on_loan_qty !== outstanding) bad.push(`on_loan ${s.on_loan_qty} != outstanding ${outstanding}`);
  const hand = tx.filter((t) => t.type !== 'LOAN_LOSS').reduce((n, t) => n + t.qty, 0);
  if (s.on_hand_qty !== hand) bad.push(`on_hand ${s.on_hand_qty} != txn sum ${hand}`);
  const loanSum = tx.reduce((n, t) => n + (t.type === 'LOAN' ? -t.qty : t.type === 'RETURN' ? -t.qty : t.type === 'LOAN_LOSS' ? t.qty : 0), 0);
  if (s.on_loan_qty !== loanSum) bad.push(`on_loan ${s.on_loan_qty} != txn loan sum ${loanSum}`);
  for (const l of loans) {
    const ret = tx.filter((t) => t.loan_id === l.id && t.type === 'RETURN').reduce((n, t) => n + t.qty, 0);
    const lost = -tx.filter((t) => t.loan_id === l.id && t.type === 'LOAN_LOSS').reduce((n, t) => n + t.qty, 0);
    if (ret !== l.returned_qty || lost !== l.lost_qty) bad.push(`loan ${l.id} returned/lost ${l.returned_qty}/${l.lost_qty} != txn ${ret}/${lost}`);
    if ((l.status === 'CLOSED') !== (l.returned_qty + l.lost_qty === l.qty)) bad.push(`loan ${l.id} status ${l.status}`);
  }
  if (s.on_hand_qty < 0 || s.on_loan_qty < 0) bad.push('negative');
  return bad;
}

describe('[R3] 주변기기 수량 정합성', () => {
  it('[R3-7] 지급·대여·반납·분실·입고·조정·폐기를 동시에 섞어 500번 해도 수량·이력·대여가 일치한다', async () => {
    const { stockId, modelId } = await freshStock(300);
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >>> 16) % n;
    };
    const statuses: Record<string, number> = {};
    for (let batch = 0; batch < 50; batch++) {
      const open = (await (await owner()).query("SELECT id FROM app.peripheral_loan WHERE stock_id = $1 AND status = 'OPEN'", [stockId])).rows.map((r) => r.id as string);
      const ops = Array.from({ length: 10 }, () => {
        const k = rnd(8);
        const person = rnd(2) ? id.p1 : id.p2;
        const q = 1 + rnd(5);
        const loanId = open.length ? open[rnd(open.length)] : undefined;
        if (k === 0) return post(issueRoute as Handler, 'admin', { action: 'ISSUE', stockId, personId: person, qty: q });
        if (k <= 2) return post(issueRoute as Handler, 'admin', { action: 'LOAN', stockId, personId: person, qty: q });
        if (k === 3 && loanId) return post(issueRoute as Handler, 'admin', { action: 'RETURN', loanId, qty: 1 + rnd(3) });
        if (k === 4 && loanId) return post(issueRoute as Handler, 'admin', { action: 'LOAN_LOSS', loanId, qty: 1 });
        if (k === 5) return post(receiveRoute as Handler, 'admin', { modelId, qty: q });
        if (k === 6) return post(adjustRoute as Handler, 'admin', { action: 'ADJUST', stockId, countedQty: 50 + rnd(100), note: 'count' });
        return post(adjustRoute as Handler, 'admin', { action: 'DISPOSE', stockId, qty: q, note: 'broken' });
      });
      for (const r of await Promise.all(ops)) { const k = r.status === 200 ? "200" : `${r.status}:${r.data?.error?.code}:${r.data?.error?.message}`; statuses[k] = (statuses[k] ?? 0) + 1; }
    }
    console.log(`[R3-7] status histogram ${JSON.stringify(statuses)}`);
    expect(Object.keys(statuses).filter((k) => k.startsWith('500'))).toEqual([]);
    expect(await invariants(stockId)).toEqual([]);
  }, 180000);

  it('[R3-8] 보유 수량이 상한(1,000,000)에 닿아 있어도 대여 반납은 받을 수 있다', async () => {
    const { stockId, modelId } = await freshStock(1_000_000);
    const loan = await post(issueRoute as Handler, 'admin', { action: 'LOAN', stockId, personId: id.p1, qty: 1 });
    expect(loan.status).toBe(200);
    // 상한은 보유 + 대여 중 합계에 건다: 대여 중인 1개의 자리를 입고로 채울 수 없다. 그래서 반납은 언제나 받을 수 있다.
    expect((await post(receiveRoute as Handler, 'admin', { modelId, qty: 1 })).status).toBe(400);
    const ret = await post(issueRoute as Handler, 'admin', { action: 'RETURN', loanId: loan.data.loanId, qty: 1 });
    console.log(`[R3-8] RETURN at on_hand=MAX: ${ret.status} ${JSON.stringify(ret.data)}`);
    expect(ret.status).toBe(200);
  });
});

// ─────────────────────────── 2단계 수정 재검토 ───────────────────────────

describe('[R3] 2단계 수정(L-1) 재검토', () => {
  // 결정: 분실 자산은 반납받을 수 없으므로 보유자가 있어도 퇴역(손실 처리)할 수 있다. 분실 처리와 퇴역은 같은 권한
  // (asset.retire)이고, 이력에 마지막 보유자가 남는다. "반납 없이 퇴역 불가"는 사용 중·수리 중 자산에 대한 규칙이다.
  it('[R3-9] 사용 중 자산은 바로 퇴역시킬 수 없고, 분실 처리를 거친 퇴역은 이력에 보유자가 남는다', async () => {
    const o = await owner();
    const assetId = (await o.query(
      "INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate, department_id) VALUES ($1, $2, $3, 'IN_STOCK', 'AVAILABLE', $4) RETURNING id",
      [A.id, id.laptop, uniq('L1-'), id.it],
    )).rows[0].id;
    expect((await call(withId(assignRoute as Handler, assetId), { method: 'POST', cookie: cookie.admin, body: { action: 'ASSIGN', holderPersonId: id.p2 } })).status).toBe(200);
    expect((await call(withId(retireRoute as Handler, assetId), { method: 'POST', cookie: cookie.admin, body: { action: 'RETIRE' } })).status).toBe(409);
    expect((await call(withId(retireRoute as Handler, assetId), { method: 'POST', cookie: cookie.admin, body: { action: 'MARK_MISSING' } })).status).toBe(200);
    expect((await call(withId(retireRoute as Handler, assetId), { method: 'POST', cookie: cookie.admin, body: { action: 'RETIRE' } })).status).toBe(200);
    const txns = (await o.query("SELECT type, from_holder_id FROM app.asset_txn WHERE asset_id = $1 AND type IN ('MARK_MISSING', 'RETIRE') ORDER BY seq", [assetId])).rows;
    expect(txns).toEqual([{ type: 'MARK_MISSING', from_holder_id: id.p2 }, { type: 'RETIRE', from_holder_id: id.p2 }]);
  });
});

// ─────────────────────────── 권한 표 읽기(tests/route-permissions.test.ts) ───────────────────────────

describe('[R3] 라우트 권한 표의 읽기 방식', () => {
  it("[R3-10] access: 'type' 라우트의 허용 유형(allow)이 표에 기록된다", async () => {
    const { readFileSync } = await import('node:fs');
    // route-permissions.test.ts 와 같은 추출식(route() 의 필드 이름은 `allow` 다).
    const src = readFileSync('src/app/api/system/acting-company/route.ts', 'utf8');
    const types = /allow:\s*\[([^\]]*)\]/.exec(src)?.[1]?.replace(/['\s]/g, '');
    expect(types).toBe('SYSTEM_ADMIN');
  });
});

// ─────────────────────────── 살아남은 변이를 잡는 보강(통과해야 정상) ───────────────────────────

describe('[R3-gap] 변이 테스트에서 살아남은 규칙(현재 동작은 맞다)', () => {
  it('비활성 부서로는 입고할 수 없다', async () => {
    const o = await owner();
    const dept = (await o.query('INSERT INTO app.department (company_id, name, is_active) VALUES ($1, $2, false) RETURNING id', [A.id, uniq('OFF')])).rows[0].id;
    const { modelId } = await freshStock(1);
    const r = await post(receiveRoute as Handler, 'admin', { modelId, qty: 1, departmentId: dept });
    expect(r.status).toBe(400);
    expect((await one('SELECT count(*)::int AS n FROM app.peripheral_stock WHERE department_id = $1', [dept])).n).toBe(0);
  });

  it('입고 후 보유 수량이 상한을 넘으면 거부한다', async () => {
    const { stockId, modelId } = await freshStock(999_999);
    const r = await post(receiveRoute as Handler, 'admin', { modelId, qty: 2 });
    expect(r.status).toBe(400);
    expect((await one('SELECT on_hand_qty FROM app.peripheral_stock WHERE id = $1', [stockId])).on_hand_qty).toBe(999_999);
  });

  it('범위 밖 대여 ID 로 반납하면 없는 ID 와 같은 응답(404, 같은 본문)이다', async () => {
    const o = await owner();
    const { stockId } = await freshStock(5); // 기본 부서(IT)
    const loan = await post(issueRoute as Handler, 'admin', { action: 'LOAN', stockId, personId: id.p1, qty: 1 });
    const login = uniq('hrissuer');
    await userWith(A, login, [['peripheral.stock', 'read'], ['peripheral.issue', 'execute']], [id.hr!]);
    const outside = await post(issueRoute as Handler, login, { action: 'RETURN', loanId: loan.data.loanId, qty: 1 });
    const missing = await post(issueRoute as Handler, login, { action: 'RETURN', loanId: '00000000-0000-4000-8000-00000000abcd', qty: 1 });
    expect(outside.status).toBe(404);
    expect(outside.data).toEqual(missing.data);
    expect((await o.query('SELECT returned_qty FROM app.peripheral_loan WHERE id = $1', [loan.data.loanId])).rows[0].returned_qty).toBe(0);
  });

  it('처리 종류에 없는 필드를 섞으면 400', async () => {
    const { stockId } = await freshStock(5);
    const r = await post(issueRoute as Handler, 'admin', { action: 'ISSUE', stockId, personId: id.p1, qty: 1, loanId: '00000000-0000-4000-8000-00000000abcd' });
    expect(r.status).toBe(400);
    const r2 = await post(adjustRoute as Handler, 'admin', { action: 'DISPOSE', stockId, qty: 1, countedQty: 0, note: 'x' });
    expect(r2.status).toBe(400);
  });
});

describe('[R3-gap] 2단계 수정의 살아남은 변이(현재 동작은 맞다)', () => {
  it('역할 관리자는 자기보다 권한이 많은(범위는 같은) 계정이 쓰는 역할을 고칠 수 없다', async () => {
    const { PATCH: rolePatch } = await import('@/app/api/admin/roles/[id]/route');
    const o = await owner();
    const mkRole = async (acl: [string, string][]) => {
      const r = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [A.id, uniq('r')])).rows[0].id as string;
      for (const [res, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [r, res, op]);
      return r;
    };
    const shared = await mkRole([['asset.item', 'read']]);
    const extra = await mkRole([['asset.retire', 'execute']]);
    const editorLogin = uniq('roleed');
    await userWith(A, editorLogin, [['asset.item', 'read'], ['admin.role', 'read'], ['admin.role', 'update']]);
    const bigLogin = uniq('big');
    const big = await userWith(A, bigLogin, [['asset.item', 'read']]);
    await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3), ($1, $4, $3)', [big, shared, A.id, extra]);
    const r = await call(withId(rolePatch as Handler, shared), { method: 'PATCH', cookie: cookie[editorLogin], body: { description: 'x' } });
    expect(r.status).toBe(403);
  });

  it('제한 필드 수정 권한만 있고 조회 권한이 없으면 제한 여부를 바꿀 수 없다', async () => {
    const { PATCH: cfPatch } = await import('@/app/api/master/custom-fields/[id]/route');
    const o = await owner();
    const f = (await o.query("INSERT INTO app.custom_field_def (company_id, key, label, data_type, is_restricted, sort_order, is_active) VALUES ($1, $2, 'L', 'text', true, 0, true) RETURNING id", [A.id, uniq('k').toLowerCase()])).rows[0].id;
    const login = uniq('cfed');
    await userWith(A, login, [['master.custom_field', 'read'], ['master.custom_field', 'update'], ['asset.item.custom_restricted', 'update']]);
    const r = await call(withId(cfPatch as Handler, f), { method: 'PATCH', cookie: cookie[login], body: { isRestricted: false } });
    expect(r.status).toBe(403);
    expect((await one('SELECT is_restricted FROM app.custom_field_def WHERE id = $1', [f])).is_restricted).toBe(true);
  });

  it('업로드: 카테고리 등록 권한 없이 모델 등록 권한만 있으면 새 카테고리는 만들지 않는다', async () => {
    const login = uniq('modonly');
    await userWith(A, login, [['asset.item', 'read'], ['asset.item', 'create'], ['asset.item', 'import'], ['master.model', 'create']]);
    const r = await upload(importAssets as Handler, login, xlsx([H.assets, asset(uniq('C-'), { 1: uniq('NewCat'), 3: uniq('NewModel') })]));
    expect(r.status).toBe(422);
    expect(r.data.errors[0].message).toContain('카테고리 등록 권한');
  });

  it('업로드: NUL 문자가 든 셀은 행 오류(500 아님)', async () => {
    const sheet = `<worksheet><sheetData><row r="1">${H.persons.map((h, i) => `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${h}</t></is></c>`).join('')}</row>` +
      '<row r="2"><c r="B2" t="inlineStr"><is><t>a\u0000b</t></is></c></row></sheetData></worksheet>';
    const r = await upload(importPersons as Handler, 'admin', rawSheet(sheet), 'preview');
    expect(r.status).toBe(200);
    expect(r.data.errors[0].message).toContain('사용할 수 없는 문자');
  });

  it('업로드: 5MB 를 넘는 본문은 413 (content-length 가 없거나 작게 속여도)', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    big[0] = 0x50; big[1] = 0x4b;
    const stream = new ReadableStream({ start(c) { c.enqueue(big); c.close(); } });
    const res = await importPersons(new Request('http://app.test/api/import/persons?mode=preview', {
      method: 'POST', headers: { host: 'app.test', origin: 'http://app.test', cookie: cookie.admin!, 'content-length': '100' }, body: stream, duplex: 'half',
    } as RequestInit));
    expect(res.status).toBe(413);
    const res2 = await importPersons(new Request('http://app.test/api/import/persons?mode=preview', {
      method: 'POST', headers: { host: 'app.test', origin: 'http://app.test', cookie: cookie.admin!, 'content-length': String(6 * 1024 * 1024) }, body: new Uint8Array(10),
    }));
    expect(res2.status).toBe(413);
  });
});
