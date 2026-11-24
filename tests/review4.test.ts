// 4단계 독립 검토(review4): 결함 재현 테스트. 조치 뒤에는 모두 통과해야 한다(docs/REVIEW-phase4.md). 일부 테스트 이름은 발견 당시의 결함을 적은 것이다.
// 각 테스트 이름 앞의 [R4-x] 는 검토 보고서의 번호다.
import { strToU8, zipSync } from 'fflate';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as alertsList } from '@/app/api/alerts/route';
import { PATCH as assetPatch } from '@/app/api/assets/[id]/route';
import { POST as departmentCreate } from '@/app/api/departments/route';
import { POST as importPeripherals } from '@/app/api/import/peripherals/route';
import { GET as previewRoute } from '@/app/api/mail/schedules/[id]/preview/route';
import { POST as scheduleCreate } from '@/app/api/mail/schedules/route';
import { PATCH as modelPatch } from '@/app/api/master/models/[id]/route';
import { POST as issueRoute } from '@/app/api/peripherals/issue/route';
import { POST as receiveRoute } from '@/app/api/peripherals/receive/route';
import { GET as stockList } from '@/app/api/peripherals/route';
import { POST as thresholdCreate } from '@/app/api/thresholds/route';
import { closePool } from '@/lib/db/pool';
import { IMPORT_COLUMNS } from '@/lib/import/run';
import { readXlsx } from '@/lib/import/xlsx';
import { call, closeOwner, makeCompany, owner, sessionFor, uniq, type TestCompany } from './helpers';
import pg from 'pg';

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};
type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
type Row = (string | number | null)[];
const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });
const one = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];
const q = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows;
const post = (h: Handler, as: string, body: Record<string, unknown>) => call(h, { method: 'POST', cookie: cookie[as], body });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WB = strToU8('<workbook><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>');
const RELS = strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
const rawSheet = (sheet: string) => zipSync({ 'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': strToU8(sheet) }, { level: 9 });
function xlsx(rows: Row[]): Uint8Array {
  const col = (i: number) => String.fromCharCode(65 + i);
  const body = rows
    .map((cells, r) => `<row r="${r + 1}">` + cells.map((v, c) =>
      v === null ? '' : typeof v === 'number' ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('') + '</row>')
    .join('');
  return rawSheet(`<worksheet><sheetData>${body}</sheetData></worksheet>`);
}
const PH = IMPORT_COLUMNS.peripherals.map((c) => c.header);

function uploadReq(as: string, body: BodyInit | ReadableStream, mode = 'commit'): Request {
  return new Request(`http://app.test/api/import/peripherals?mode=${mode}`, {
    method: 'POST',
    headers: { host: 'app.test', origin: 'http://app.test', cookie: cookie[as]!, 'content-type': 'application/octet-stream' },
    body: body as BodyInit,
    // @ts-expect-error Node 의 스트림 본문
    duplex: 'half',
  });
}

/** 테이블 소유자로 따로 연 연결. 잠금을 쥐고 있다가 놓는 데 쓴다. */
async function lockHolder(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.TEST_OWNER_URL });
  await c.connect();
  return c;
}

async function peripheralModel(company: TestCompany, categoryId: string, name = uniq('PM')): Promise<string> {
  return (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'R4', $3) RETURNING id", [company.id, categoryId, name])).id;
}
async function assetModel(categoryId: string): Promise<string> {
  return (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'R4', $3) RETURNING id", [A.id, categoryId, uniq('AM')])).id;
}
async function category(company: TestCompany, kind: 'ASSET' | 'PERIPHERAL'): Promise<string> {
  return (await one('INSERT INTO app.category (company_id, kind, name) VALUES ($1, $2, $3) RETURNING id', [company.id, kind, uniq('C')])).id;
}

beforeAll(async () => {
  A = await makeCompany('R4A');
  B = await makeCompany('R4B');
  id.it = (await one('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A.id])).id;
  id.bit = (await one('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [B.id])).id;
  id.p1 = (await one("INSERT INTO app.person (company_id, name) VALUES ($1, 'Kim') RETURNING id", [A.id])).id;
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

// ─────────────────────────── 엑셀 읽기 ───────────────────────────

describe('[R4] xlsx', () => {
  it('[R4-1] 64KB 입력 한 번에 67MB 를 풀어 낸 뒤에야 한도(1MB/16MB)를 검사한다: 72KB 파일이 약 200MB 메모리와 0.25초를 쓴다', () => {
    // 70MB 의 0 을 deflate → 첫 64KB 입력 조각 하나가 ~67MB 를 낸다(fflate 의 push 는 조각 전체를 한 번에 푼다).
    const bomb = deflateRawSync(Buffer.alloc(70 * 1024 * 1024), { level: 9 });
    const file = zipSync({ 'xl/_rels/workbook.xml.rels': RELS }, { level: 0 });
    // xl/workbook.xml(한도 1MB) 자리에 넣는다: 중앙 디렉터리를 직접 쓴다.
    const name = strToU8('xl/workbook.xml');
    const lh = new Uint8Array(30 + name.length); const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(18, bomb.length, true); lv.setUint16(26, name.length, true); lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(20, bomb.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, 0, true); ch.set(name, 46);
    const e = new Uint8Array(22); const ev = new DataView(e.buffer);
    const cdOff = lh.length + bomb.length;
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, ch.length, true); ev.setUint32(16, cdOff, true);
    const zip = new Uint8Array(cdOff + ch.length + 22);
    zip.set(lh, 0); zip.set(bomb, lh.length); zip.set(ch, cdOff); zip.set(e, cdOff + ch.length);
    void file;
    const rss0 = process.resourceUsage().maxRSS;
    const t = performance.now();
    expect(() => readXlsx(zip)).toThrow();
    const ms = performance.now() - t;
    const grew = (process.resourceUsage().maxRSS - rss0) / 1024;
    console.log(`[R4-1] ${zip.length} B file, 1MB-capped part: ${ms.toFixed(0)} ms, peak RSS +${grew.toFixed(0)} MB`);
    expect(grew).toBeLessThan(32);
  });

  it("[R4-2] 작은따옴표 속성(r='C1' t='s')은 무시되어 값이 다른 열로 밀리고, 공유 문자열 번호가 숫자로 들어간다", () => {
    const zip = zipSync({
      'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS,
      'xl/sharedStrings.xml': strToU8('<sst><si><t>alpha</t></si><si><t>gamma</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8("<worksheet><sheetData><row r='1'><c r='A1' t='s'><v>0</v></c><c r='C1' t='s'><v>1</v></c></row></sheetData></worksheet>"),
    });
    const rows = readXlsx(zip);
    console.log(`[R4-2] parsed: ${JSON.stringify(rows)}`);
    expect(rows[0]).toEqual(['alpha', null, 'gamma']);
  });

  it('[R4-3] 속성의 = 앞뒤 공백(r = "C1")도 같은 결과(열 밀림)', () => {
    const rows = readXlsx(rawSheet('<worksheet><sheetData><row r="1"><c r = "A1"><v>1</v></c><c r = "C1"><v>3</v></c></row></sheetData></worksheet>'));
    expect(rows[0]).toEqual([1, null, 3]);
  });
});

// ─────────────────────────── 업로드 자리(세마포어) ───────────────────────────

describe('[R4] 업로드 동시 1건 제한', () => {
  it('[R4-4] 본문을 끝내지 않는 업로드 하나가 모든 기업의 업로드를 429 로 막는다(입고 권한만 있으면 된다)', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new Uint8Array([0x50, 0x4b])); } });
    const slow = importPeripherals(uploadReq('admin', stream) as Request);
    await sleep(200);
    const other = await importPeripherals(uploadReq('badmin', xlsx([PH, ['Mouse', 'R4', 'M1', null, 1]]) as BodyInit, 'preview'));
    console.log(`[R4-4] company B upload while company A trickles its body: ${other.status}`);
    controller.error(new Error('client gone'));
    await slow;
    expect(other.status).not.toBe(429);
  });
});

// ─────────────────────────── 한계 수량: 교착·누락·반올림 ───────────────────────────

describe('[R4] 한계 수량 판정', () => {
  it('[R4-5] 두 자산의 모델을 서로 맞바꾸는 수정 두 건이 동시에 오면 교착(40P01)으로 한쪽이 500', async () => {
    const cat1 = await category(A, 'ASSET');
    const cat2 = await category(A, 'ASSET');
    const m1 = await assetModel(cat1);
    const m2 = await assetModel(cat2);
    const t1 = (await post(thresholdCreate as Handler, 'admin', { modelId: m1, minQty: 0 })).data.thresholdId as string;
    const t2 = (await post(thresholdCreate as Handler, 'admin', { modelId: m2, minQty: 0 })).data.thresholdId as string;
    const a = (await one("INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate, department_id) VALUES ($1, $2, $3, 'IN_STOCK', 'AVAILABLE', $4) RETURNING id", [A.id, m1, uniq('DL'), id.it])).id;
    const b = (await one("INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate, department_id) VALUES ($1, $2, $3, 'IN_STOCK', 'AVAILABLE', $4) RETURNING id", [A.id, m2, uniq('DL'), id.it])).id;
    // 두 한계 수량 행을 잠깐 쥐고 있다가 동시에 놓아, 두 요청이 각자 첫 번째 잠금을 얻게 한다.
    const x = await lockHolder();
    await x.query('BEGIN');
    await x.query('SELECT 1 FROM app.stock_threshold WHERE id = ANY($1) FOR UPDATE', [[t1, t2]]);
    const p1 = call(withId(assetPatch as Handler, a), { method: 'PATCH', cookie: cookie.admin, body: { modelId: m2 } });
    const p2 = call(withId(assetPatch as Handler, b), { method: 'PATCH', cookie: cookie.admin, body: { modelId: m1 } });
    await sleep(500);
    await x.query('COMMIT');
    await x.end();
    const statuses = (await Promise.all([p1, p2])).map((r) => r.status);
    console.log(`[R4-5] concurrent model swap A:M1->M2, B:M2->M1 statuses ${statuses}`);
    expect(statuses).toEqual([200, 200]);
  });

  it('[R4-6] 주변기기 업로드(같은 카테고리의 두 모델)와 같은 카테고리의 지급이 겹치면 교착으로 한쪽이 500', async () => {
    const cat = await category(A, 'PERIPHERAL');
    const catName = (await one('SELECT name FROM app.category WHERE id = $1', [cat])).name as string;
    const n1 = uniq('P'); const n2 = uniq('P');
    await peripheralModel(A, cat, n1);
    const m2 = await peripheralModel(A, cat, n2);
    const s2 = (await post(receiveRoute as Handler, 'admin', { modelId: m2, qty: 10 })).data.stockId as string;
    await post(thresholdCreate as Handler, 'admin', { categoryId: cat, minQty: 0 }); // 카테고리 한계 수량
    // 업로드가 1행(n1)을 마치고(카테고리 한계 수량 잠금 보유) 2행(n2)의 모델 확인에서 멈추게, 모델 n2 행을 잠깐 쥔다.
    const x = await lockHolder();
    await x.query('BEGIN');
    await x.query('SELECT 1 FROM app.item_model WHERE id = $1 FOR UPDATE', [m2]);
    const imp = importPeripherals(uploadReq('admin', xlsx([PH, [catName, 'R4', n1, null, 1], [catName, 'R4', n2, null, 1]]) as BodyInit));
    await sleep(500);
    const issue = post(issueRoute as Handler, 'admin', { action: 'ISSUE', stockId: s2, personId: id.p1, qty: 1 }); // 재고 행 잠금 → 카테고리 한계 수량 대기
    await sleep(500);
    await x.query('COMMIT');
    await x.end();
    const [ri, rs] = await Promise.all([imp, issue]);
    console.log(`[R4-6] import status ${ri.status}, issue status ${rs.status}`);
    expect([ri.status, rs.status]).toEqual([200, 200]);
  });

  it('[R4-7] 업로드가 카테고리 한계 수량을 잡고 있는 동안 같은 카테고리의 처리가 모두 기다리며 연결을 붙잡아, 다른 기업의 요청이 실패한다', async () => {
    const cat = await category(A, 'PERIPHERAL');
    const catName = (await one('SELECT name FROM app.category WHERE id = $1', [cat])).name as string;
    const n1 = uniq('P');
    await peripheralModel(A, cat, n1);
    const m2 = await peripheralModel(A, cat);
    const s2 = (await post(receiveRoute as Handler, 'admin', { modelId: m2, qty: 100 })).data.stockId as string;
    await post(thresholdCreate as Handler, 'admin', { categoryId: cat, minQty: 0 });
    // 기존 자산이 많은 기업을 흉내: 카테고리 수량 계산 비용(행마다 다시 센다)
    const rows: Row[] = [PH];
    for (let i = 0; i < 2000; i++) rows.push([catName, 'R4', n1, null, 1]);
    const file = xlsx(rows);
    const t0 = performance.now();
    const imp = importPeripherals(uploadReq('admin', file as BodyInit)).then((r) => ({ status: r.status, ms: performance.now() - t0 }));
    await sleep(300);
    const issues = Array.from({ length: 5 }, () => post(issueRoute as Handler, 'admin', { action: 'ISSUE', stockId: s2, personId: id.p1, qty: 1 }));
    await sleep(300);
    const t1 = performance.now();
    const other = await call(stockList as Handler, { path: '/api/peripherals', cookie: cookie.badmin });
    const otherMs = performance.now() - t1;
    const i = await imp;
    const st = (await Promise.all(issues)).map((r) => r.status);
    console.log(`[R4-7] 2000-row peripheral import ${i.status} in ${i.ms.toFixed(0)} ms; 5 issues ${st}; company B GET ${other.status} in ${otherMs.toFixed(0)} ms`);
    expect(other.status).toBe(200);
    expect(otherMs).toBeLessThan(1000);
  }, 120000);

  it('[R4-8] 여유 비율 1.1, 한계 100 이면 110개에서 회복이어야 하는데 부동소수 오차(100×1.1=110.00000000000001)로 111개가 필요하다', async () => {
    const cat = await category(A, 'PERIPHERAL');
    const m = await peripheralModel(A, cat);
    await post(receiveRoute as Handler, 'admin', { modelId: m, qty: 99 });
    const t = (await post(thresholdCreate as Handler, 'admin', { modelId: m, minQty: 100, warnRatio: 1.1 })).data.thresholdId as string;
    expect((await one('SELECT state FROM app.stock_threshold WHERE id = $1', [t])).state).toBe('LOW');
    await post(receiveRoute as Handler, 'admin', { modelId: m, qty: 11 }); // 110 = 100 × 1.1
    expect((await one('SELECT state FROM app.stock_threshold WHERE id = $1', [t])).state).toBe('OK');
  });

  it('[R4-9] 모델을 다른 카테고리로 옮겨도 두 카테고리의 한계 수량을 다시 판정하지 않는다(부족 알림 누락)', async () => {
    const c1 = await category(A, 'PERIPHERAL');
    const c2 = await category(A, 'PERIPHERAL');
    const m = await peripheralModel(A, c1);
    await post(receiveRoute as Handler, 'admin', { modelId: m, qty: 5 });
    const t = (await post(thresholdCreate as Handler, 'admin', { categoryId: c1, minQty: 1 })).data.thresholdId as string;
    const r = await call(withId(modelPatch as Handler, m), { method: 'PATCH', cookie: cookie.admin, body: { categoryId: c2 } });
    expect(r.status).toBe(200);
    // 카테고리 c1 의 사용 가능 수량은 이제 0 < 1
    expect((await one('SELECT state FROM app.stock_threshold WHERE id = $1', [t])).state).toBe('LOW');
  });
});

// ─────────────────────────── 날짜 알림 ───────────────────────────

describe('[R4] 날짜 알림', () => {
  it('[R4-10] 연체가 한 번에 알리는 건수를 넘어도, 계산할 때마다 다음 건들이 차례로 알려져 빠지는 건이 없다', async () => {
    const C = await makeCompany('R4L');
    cookie.ladmin = await sessionFor(C.code, 'admin');
    const dept = (await one('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [C.id])).id;
    const cat = await category(C, 'ASSET');
    const model = (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'R4', 'L') RETURNING id", [C.id, cat])).id;
    const person = (await one("INSERT INTO app.person (company_id, name) VALUES ($1, 'Lee') RETURNING id", [C.id])).id;
    await q(
      `INSERT INTO app.asset (company_id, model_id, asset_tag, state, holder_person_id, due_date, department_id)
       SELECT $1, $2, 'OD-' || g, 'IN_USE', $3, current_date - 600 + g, $4 FROM generate_series(1, 501) g`,
      [C.id, model, person, dept],
    );
    const { runDailyAlerts, MAX_PER_KIND } = await import('@/lib/alerts/daily');
    const { withTenant } = await import('@/lib/db/context');
    for (let i = 0; i < Math.ceil(501 / MAX_PER_KIND); i++) await withTenant(C.id, (db) => runDailyAlerts(db, C.id));
    const n = (await one("SELECT count(*)::int AS n FROM app.notification WHERE company_id = $1 AND type = 'LOAN_OVERDUE'", [C.id])).n;
    console.log(`[R4-10] 501 overdue assets → notifications after 3 inbox loads: ${n}`);
    expect(n).toBe(501);
  });

  it('[R4-11] GET /api/alerts(light 없이)는 매번 날짜 알림 쿼리 세 개를 돌린다: 받을 사람·대상이 많을 때의 비용', async () => {
    const C = await makeCompany('R4P');
    cookie.padmin = await sessionFor(C.code, 'admin');
    const dept = (await one('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [C.id])).id;
    const cat = await category(C, 'ASSET');
    const model = (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'R4', 'P') RETURNING id", [C.id, cat])).id;
    const person = (await one("INSERT INTO app.person (company_id, name) VALUES ($1, 'Park') RETURNING id", [C.id])).id;
    await q(
      `INSERT INTO app.asset (company_id, model_id, asset_tag, state, holder_person_id, due_date, warranty_end, department_id)
       SELECT $1, $2, 'PF-' || g, 'IN_USE', $3, current_date - 1 - g, current_date + (g % 30), $4 FROM generate_series(1, 500) g`,
      [C.id, model, person, dept],
    );
    // 기업 관리자 200명(받을 사람)
    await q(
      `INSERT INTO app.app_user (company_id, login_id, password_hash, display_name, user_type)
       SELECT $1, 'user' || g, 'x', 'user' || g, 'COMPANY_ADMIN' FROM generate_series(1, 200) g`,
      [C.id],
    );
    let t = performance.now();
    await call(alertsList as Handler, { path: '/api/alerts?pageSize=1', cookie: cookie.padmin });
    const first = performance.now() - t;
    const made = (await one('SELECT count(*)::int AS n FROM app.notification WHERE company_id = $1', [C.id])).n;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      t = performance.now();
      await call(alertsList as Handler, { path: '/api/alerts?pageSize=1', cookie: cookie.padmin });
      times.push(Math.round(performance.now() - t));
    }
    console.log(`[R4-11] first GET ${first.toFixed(0)} ms created ${made} rows; repeated GETs (nothing new) ${times.join(',')} ms`);
    expect(Math.min(...times)).toBeLessThan(100);
  }, 120000);

  it('[R4-11b] 알림함 조회 권한(Viewer 도 가진다)만 있는 계정이 GET /api/alerts 15건을 동시에 보내면 다른 기업의 요청이 연결 풀 고갈로 실패한다', async () => {
    const calls = Array.from({ length: 15 }, () => call(alertsList as Handler, { path: '/api/alerts?pageSize=1', cookie: cookie.padmin }));
    await sleep(200);
    const t = performance.now();
    const other = await call(stockList as Handler, { path: '/api/peripherals', cookie: cookie.badmin });
    const ms = performance.now() - t;
    const st = (await Promise.all(calls)).map((r) => r.status);
    console.log(`[R4-11b] 15 concurrent inbox GETs ${st}; company B GET ${other.status} in ${ms.toFixed(0)} ms`);
    expect(other.status).toBe(200);
    expect(ms).toBeLessThan(1000);
  }, 120000);
});

// ─────────────────────────── 메일 ───────────────────────────

describe('[R4] 메일', () => {
  it('[R4-12] 200행을 넘는 본문의 "외 N건"이 항상 1건이다(LIMIT 201 로 센다)', async () => {
    const cat = await category(A, 'ASSET');
    const model = await assetModel(cat);
    const dept = (await post(departmentCreate as Handler, 'admin', { name: uniq('MailDept') })).data.departmentId as string;
    await q(
      `INSERT INTO app.asset (company_id, model_id, asset_tag, state, holder_person_id, due_date, department_id)
       SELECT $1, $2, $3 || g, 'IN_USE', $4, current_date + g, $5 FROM generate_series(1, 250) g`,
      [A.id, model, uniq('ML-'), id.p1, dept],
    );
    const s = await post(scheduleCreate as Handler, 'admin', {
      name: 'loans', frequency: 'DAILY', sendTime: '09:00', timezone: 'Asia/Seoul', contentType: 'OPEN_LOANS', departmentId: dept,
      recipients: { userIds: [], emails: ['ops@example.com'] },
    });
    expect(s.status).toBe(201);
    const p = await call(withId(previewRoute as Handler, s.data.scheduleId), { cookie: cookie.admin });
    const tail = (p.data.text as string).split('\n').at(-1);
    console.log(`[R4-12] 250 open loans → rows ${p.data.rows}, last line: ${tail}`);
    // 정확한 수를 세지 않고 "더 있다"고만 알린다.
    expect(tail).toContain('일부만');
  });

  it('[R4-13] 외부 주소로 보내는 일정을 만들어도 감사 로그에는 받는 사람 수만 남는다(어디로 보내는지 추적 불가)', async () => {
    const s = await post(scheduleCreate as Handler, 'admin', {
      name: 'exfil', frequency: 'DAILY', sendTime: '09:00', timezone: 'Asia/Seoul', contentType: 'OPEN_LOANS',
      recipients: { userIds: [], emails: ['someone@external.example'] },
    });
    const audit = await one("SELECT after FROM app.audit_log WHERE target_id = $1 AND action = 'MAIL_SCHEDULE_CREATED'", [s.data.scheduleId]);
    console.log(`[R4-13] audit after = ${JSON.stringify(audit.after)}`);
    expect(JSON.stringify(audit.after)).toContain('someone@external.example');
  });

  it('[R4-14] 부서 이름에 줄바꿈(CR/LF)을 넣을 수 없고, 메일 제목에도 줄바꿈이 들어가지 않는다', async () => {
    // 이름 입력에서 막는다.
    expect((await post(departmentCreate as Handler, 'admin', { name: 'Ops\r\nBcc: attacker@evil.example' })).status).toBe(400);
    // 예전 자료나 다른 경로로 이미 들어와 있어도 제목에는 줄바꿈이 남지 않는다.
    const deptId = (await one("INSERT INTO app.department (company_id, name) VALUES ($1, E'Ops\\r\\nBcc: attacker@evil.example') RETURNING id", [A.id])).id;
    const s = await post(scheduleCreate as Handler, 'admin', {
      name: 'subj', frequency: 'DAILY', sendTime: '09:00', timezone: 'Asia/Seoul', contentType: 'LOW_STOCK', departmentId: deptId,
      recipients: { userIds: [], emails: ['ops@example.com'] },
    });
    const p = await call(withId(previewRoute as Handler, s.data.scheduleId), { cookie: cookie.admin });
    console.log(`[R4-14] subject = ${JSON.stringify(p.data.subject)}`);
    expect(p.data.subject).not.toMatch(/[\r\n]/);
  });

  it('[R4-15] 받는 주소 형식 검사가 < > , ; " 와 제어 문자를 통과시킨다', async () => {
    const bad = ['x@y.z>', '<x@y.z', 'x,y@z.w', 'x;y@z.w', '"x"@y.z', 'x\u0001@y.z', 'x@y.z\u007f'];
    const accepted: string[] = [];
    for (const e of bad) {
      const r = await post(scheduleCreate as Handler, 'admin', {
        name: 'fmt', frequency: 'DAILY', sendTime: '09:00', timezone: 'Asia/Seoul', contentType: 'LOW_STOCK', recipients: { userIds: [], emails: [e] },
      });
      if (r.status === 201) accepted.push(JSON.stringify(e));
    }
    console.log(`[R4-15] accepted: ${accepted.join(' ')}`);
    expect(accepted).toEqual([]);
  });
});
