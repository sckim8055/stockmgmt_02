// 대시보드 이력 추이의 "엑셀 업로드 제외"(excludeImports=true).
// 지키려는 것
//  - 엑셀 업로드(종류별 업로드·통합 파일)가 남긴 이력은 빠지고, 직접 처리한 이력은 남는다(업로드와 같은 분·같은 초에 한 처리도).
//  - 매개변수가 없으면 지금과 같다(모두 센다). 미리보기 업로드는 아무것도 남기지 않는다.
//  - 다른 기업의 업로드(감사 기록)는 이 기업의 추이에 영향을 주지 않는다. 부서 범위가 제한된 사용자도 범위 안에서 같다.
//  - 잘못된 값은 400, 대시보드 권한이 없으면 403.
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as createAssetRoute } from '@/app/api/assets/route';
import { POST as assignRoute } from '@/app/api/assets/[id]/assign/route';
import { GET as dashboardRoute } from '@/app/api/dashboard/route';
import { POST as importAssets } from '@/app/api/import/assets/route';
import { POST as importPeripherals } from '@/app/api/import/peripherals/route';
import { POST as importPersons } from '@/app/api/import/persons/route';
import { POST as importWorkbook } from '@/app/api/import/workbook/route';
import { POST as receiveRoute } from '@/app/api/peripherals/receive/route';
import { closePool } from '@/lib/db/pool';
import { IMPORT_COLUMNS } from '@/lib/import/run';
import { call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const cookie: Record<string, string> = {};
const id: Record<string, string> = {};
type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
type Row = (string | number | null)[];
type TrendRow = { month: string; type: string; n: number };

const one = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];
const txnCount = async (table: 'asset_txn' | 'peripheral_txn', companyId: string) => (await one(`SELECT count(*)::int AS n FROM app.${table} WHERE company_id = $1`, [companyId])).n as number;
const auditCount = async (companyId: string) => (await one("SELECT count(*)::int AS n FROM app.audit_log WHERE company_id = $1 AND action = 'IMPORT_COMMITTED'", [companyId])).n as number;
const sum = (rows: TrendRow[] | null) => (rows ?? []).reduce((n, r) => n + r.n, 0);

const col = (i: number) => (i < 26 ? '' : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const sheetXml = (rows: Row[]) =>
  `<worksheet><sheetData>${rows
    .map((cells, r) => `<row r="${r + 1}">` + cells.map((v, c) => (v === null ? '' : typeof v === 'number' ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('') + '</row>')
    .join('')}</sheetData></worksheet>`;
function book(sheets: { name: string; rows: Row[] }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(`<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows)); });
  return zipSync(files);
}
async function upload(handler: Handler, as: string, file: Uint8Array, mode: 'preview' | 'commit' = 'commit') {
  const res = await handler(new Request(`http://app.test/api/import/x?mode=${mode}`, {
    method: 'POST',
    headers: { host: 'app.test', origin: 'http://app.test', cookie: cookie[as]!, 'content-type': 'application/octet-stream' },
    body: file as BodyInit,
  }));
  return { status: res.status, data: await res.json() };
}
const header = (kind: keyof typeof IMPORT_COLUMNS) => IMPORT_COLUMNS[kind].map((c) => c.header);
const withHeader = (kind: keyof typeof IMPORT_COLUMNS, values: Record<string, string | number>[]): Row[] => [
  header(kind),
  ...values.map((v) => IMPORT_COLUMNS[kind].map((c) => v[c.key] ?? null)),
];
const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });

const dash = async (as: string, qs = '') => {
  const r = await call(dashboardRoute, { cookie: cookie[as], path: `/api/dashboard?${qs}` });
  expect(r.status, `${as} ${qs}: ${JSON.stringify(r.data)}`).toBe(200);
  return r.data;
};

/** 업로드 전 기준: 테스트가 따로 넣은 자료 없이 import 들이 남긴 이력 수 */
const counts = { importedAsset: 0, importedPeripheral: 0, manualAsset: 0, manualPeripheral: 0, hrImported: 0, hrManual: 0 };

beforeAll(async () => {
  A = await makeCompany('DIA');
  B = await makeCompany('DIB');
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  const o = await owner();
  id.hr = (await o.query("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [A.id])).rows[0].id;
  // 부서 범위가 HR 로 제한된 사용자
  const uid = await makeUser(A.id, 'hruser', 'COMPANY_USER');
  const r = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [A.id, uniq('role')])).rows[0].id;
  for (const [res, op] of [['dashboard', 'read'], ['asset.item', 'read'], ['history.stock', 'read'], ['peripheral.stock', 'read']]) {
    await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [r, res, op]);
  }
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [uid, r, A.id]);
  await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [uid, id.hr, A.id]);
  cookie.hruser = await sessionFor(A.code, 'hruser');
  const nodash = await makeUser(A.id, 'nodash', 'COMPANY_USER');
  const r2 = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [A.id, uniq('role')])).rows[0].id;
  await o.query("INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, 'asset.item', 'read'), ($1, 'history.stock', 'read')", [r2]);
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [nodash, r2, A.id]);
  cookie.nodash = await sessionFor(A.code, 'nodash');

  // 1) 종류별 업로드: 직원 → 자산(배정 1, 퇴역 1, HR 1) → 주변기기
  expect((await upload(importPersons, 'admin', book([{ name: 's', rows: withHeader('persons', [{ employeeNo: 'E1', name: 'Kim' }, { employeeNo: 'E2', name: 'Lee' }]) }]))).data.committed).toBe(true);
  const assetsFile = book([{ name: 's', rows: withHeader('assets', [
    { assetTag: 'IM-1', category: '노트북', manufacturer: 'Lenovo', model: 'X1', holderEmployeeNo: 'E1' },
    { assetTag: 'IM-2', category: '노트북', manufacturer: 'Lenovo', model: 'X1', status: '퇴역' },
    { assetTag: 'IM-3', category: '노트북', manufacturer: 'Lenovo', model: 'X1', department: 'HR' },
  ]) }]);
  // 미리보기는 아무것도 남기지 않는다(뺄 것도 없다)
  const before = { a: await txnCount('asset_txn', A.id), audit: await auditCount(A.id) };
  expect((await upload(importAssets, 'admin', assetsFile, 'preview')).data.committed).toBe(false);
  expect({ a: await txnCount('asset_txn', A.id), audit: await auditCount(A.id) }).toEqual(before);
  expect((await upload(importAssets, 'admin', assetsFile)).data.committed).toBe(true);
  expect((await upload(importPeripherals, 'admin', book([{ name: 's', rows: withHeader('peripherals', [{ category: '마우스', manufacturer: 'Logi', model: 'M1', qty: 5 }]) }]))).data.committed).toBe(true);

  // 2) 통합 파일: 직원·자산(HR 1, 배정 1)·주변기기 시트 → 시트마다 감사 기록 하나, 시각은 모두 같다
  const wb = book([
    { name: '직원', rows: withHeader('persons', [{ employeeNo: 'E3', name: 'Park' }]) },
    { name: '자산', rows: withHeader('assets', [
      { assetTag: 'WB-1', category: '모니터', manufacturer: 'Dell', model: 'U27', holderEmployeeNo: 'E3' },
      { assetTag: 'WB-2', category: '모니터', manufacturer: 'Dell', model: 'U27', department: 'HR' },
    ]) },
    { name: '주변기기', rows: withHeader('peripherals', [{ category: '케이블', manufacturer: 'Belkin', model: 'C1', qty: 3 }]) },
  ]);
  const beforeWb = { a: await txnCount('asset_txn', A.id), audit: await auditCount(A.id) };
  expect((await upload(importWorkbook, 'admin', wb, 'preview')).data.committed).toBe(false);
  expect({ a: await txnCount('asset_txn', A.id), audit: await auditCount(A.id) }).toEqual(beforeWb);
  expect((await upload(importWorkbook, 'admin', wb)).data.committed).toBe(true);
  const wbAudit = (await o.query("SELECT count(*)::int AS n, count(DISTINCT created_at)::int AS t FROM app.audit_log WHERE company_id = $1 AND action = 'IMPORT_COMMITTED' AND after ->> 'workbook' = 'true'", [A.id])).rows[0];
  expect(wbAudit).toEqual({ n: 3, t: 1 });

  counts.importedAsset = await txnCount('asset_txn', A.id);
  counts.importedPeripheral = await txnCount('peripheral_txn', A.id);
  counts.hrImported = (await one('SELECT count(*)::int AS n FROM app.asset_txn t JOIN app.asset a ON a.id = t.asset_id WHERE t.company_id = $1 AND a.department_id = $2', [A.id, id.hr])).n;
  expect(counts.importedAsset).toBeGreaterThanOrEqual(7); // 등록 5 + 배정 2 + 퇴역 처리
  expect(counts.importedPeripheral).toBe(2);
  expect(counts.hrImported).toBe(2);

  // 3) 바로 이어서(같은 분 안에) 직접 처리: IT 자산 등록, HR 자산 등록 + 배정, 주변기기 입고
  id.x1 = (await one("SELECT id FROM app.item_model WHERE company_id = $1 AND name = 'X1'", [A.id])).id;
  id.m1 = (await one("SELECT id FROM app.item_model WHERE company_id = $1 AND name = 'M1'", [A.id])).id;
  id.lee = (await one("SELECT id FROM app.person WHERE company_id = $1 AND employee_no = 'E2'", [A.id])).id;
  const mk = async (tag: string, dept?: string) => {
    const res = await call(createAssetRoute, { method: 'POST', cookie: cookie.admin, path: '/api/assets', body: { modelId: id.x1, assetTag: tag, ...(dept ? { departmentId: dept } : {}) } });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    return res.data.assetId as string;
  };
  id.manualIt = await mk('MAN-1');
  id.manualHr = await mk('MAN-2', id.hr);
  const as = await call(withId(assignRoute, id.manualHr), { method: 'POST', cookie: cookie.admin, body: { action: 'ASSIGN', holderPersonId: id.lee } });
  expect(as.status, JSON.stringify(as.data)).toBe(200);
  const rc = await call(receiveRoute, { method: 'POST', cookie: cookie.admin, path: '/api/peripherals/receive', body: { modelId: id.m1, qty: 2 } });
  expect(rc.status, JSON.stringify(rc.data)).toBe(200);
  counts.manualAsset = (await txnCount('asset_txn', A.id)) - counts.importedAsset;
  counts.manualPeripheral = (await txnCount('peripheral_txn', A.id)) - counts.importedPeripheral;
  counts.hrManual = 2;
  expect(counts.manualAsset).toBe(3);
  expect(counts.manualPeripheral).toBe(1);
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('엑셀 업로드 제외', () => {
  it('excludeImports=true 이면 직접 처리한 이력만, 없으면 모두 센다(종류별 업로드 + 통합 파일)', async () => {
    const all = (await dash('admin')).trend;
    expect(all.excludeImports).toBe(false);
    expect(sum(all.asset)).toBe(counts.importedAsset + counts.manualAsset);
    expect(sum(all.peripheral)).toBe(counts.importedPeripheral + counts.manualPeripheral);
    const ex = (await dash('admin', 'excludeImports=true')).trend;
    expect(ex.excludeImports).toBe(true);
    expect(sum(ex.asset)).toBe(counts.manualAsset);
    expect(sum(ex.peripheral)).toBe(counts.manualPeripheral);
    expect(ex.asset.map((r: TrendRow) => [r.type, r.n]).sort()).toEqual([['ASSIGN', 1], ['REGISTER', 2]]);
    expect(ex.peripheral.map((r: TrendRow) => [r.type, r.n])).toEqual([['RECEIVE', 1]]);
    // 달마다의 합(차트의 막대와 핵심 수치의 추이선이 쓰는 수): 모두 이번 달, 다른 달은 0
    const thisMonth = ex.months[ex.months.length - 1];
    expect(ex.asset.every((r: TrendRow) => r.month === thisMonth)).toBe(true);
    const monthly = (rows: TrendRow[]) => ex.months.map((m: string) => rows.filter((r) => r.month === m).reduce((n, r) => n + r.n, 0));
    expect(monthly(ex.asset)).toEqual([...Array(ex.months.length - 1).fill(0), counts.manualAsset]);
    expect(monthly(all.asset).at(-1)).toBe(counts.importedAsset + counts.manualAsset);
    // 다른 패널은 바뀌지 않는다
    expect((await dash('admin', 'excludeImports=true')).assets).toEqual((await dash('admin')).assets);
  });

  it('자산 조건·퇴역 제외와 함께 걸 수 있다', async () => {
    const ex = (await dash('admin', 'excludeImports=true&active=true')).trend;
    expect(sum(ex.asset)).toBe(counts.manualAsset);
    // 퇴역 제외만 걸면 업로드로 퇴역한 자산(IM-2)의 이력만 빠진다
    const retiredTxns = (await one("SELECT count(*)::int AS n FROM app.asset_txn t JOIN app.asset a ON a.id = t.asset_id WHERE t.company_id = $1 AND a.state = 'RETIRED'", [A.id])).n;
    expect(retiredTxns).toBeGreaterThan(0);
    expect(sum((await dash('admin', 'active=true')).trend.asset)).toBe(counts.importedAsset + counts.manualAsset - retiredTxns);
  });

  it('같은 분(같은 초)에 한 직접 처리는 빠지지 않는다: 시각이 정확히 같아야 업로드로 본다', async () => {
    const o = await owner();
    // 업로드 시각 하나를 골라, 그 시각 + 1마이크로초에 이력을 넣는다(다른 트랜잭션). 빠지지 않아야 한다.
    // 시각은 SQL 안에서 옮긴다(JS Date 는 밀리초까지라 마이크로초가 잘린다).
    const last = "(SELECT created_at FROM app.audit_log WHERE company_id = $1 AND action = 'IMPORT_COMMITTED' ORDER BY created_at DESC LIMIT 1)";
    await o.query(`INSERT INTO app.asset_txn (company_id, asset_id, type, created_at) VALUES ($1, $2, 'UPDATE', ${last} + interval '1 microsecond')`, [A.id, id.manualIt]);
    expect(sum((await dash('admin', 'excludeImports=true')).trend.asset)).toBe(counts.manualAsset + 1);
    // 시각이 정확히 같으면 빠진다(이 규칙의 근거)
    await o.query(`INSERT INTO app.asset_txn (company_id, asset_id, type, created_at) VALUES ($1, $2, 'UPDATE', ${last})`, [A.id, id.manualIt]);
    expect(sum((await dash('admin', 'excludeImports=true')).trend.asset)).toBe(counts.manualAsset + 1);
    expect(sum((await dash('admin')).trend.asset)).toBe(counts.importedAsset + counts.manualAsset + 2);
    counts.manualAsset += 1;
    counts.importedAsset += 1;
  });

  it('다른 기업의 업로드는 이 기업의 추이에 영향이 없다(같은 시각이어도)', async () => {
    const o = await owner();
    // B 의 감사 기록을 A 의 직접 처리와 정확히 같은 시각으로 만든다(일부러).
    const n = await o.query(
      `INSERT INTO app.audit_log (company_id, action, resource, created_at)
       SELECT $1::uuid, 'IMPORT_COMMITTED', 'import.asset', t.created_at FROM app.asset_txn t WHERE t.company_id = $2 AND t.asset_id = ANY($3::uuid[])
       UNION ALL SELECT $1::uuid, 'IMPORT_COMMITTED', 'import.peripheral', p.created_at FROM app.peripheral_txn p WHERE p.company_id = $2 AND p.type = 'RECEIVE'`,
      [B.id, A.id, [id.manualIt, id.manualHr]],
    );
    expect(n.rowCount).toBeGreaterThanOrEqual(counts.manualAsset + counts.manualPeripheral);
    // B 에서 실제로도 올린다
    const r = await upload(importAssets, 'badmin', book([{ name: 's', rows: withHeader('assets', [{ assetTag: 'B-1', category: '노트북', manufacturer: 'Lenovo', model: 'X1' }]) }]));
    expect(r.data.committed).toBe(true);
    const ex = (await dash('admin', 'excludeImports=true')).trend;
    expect(sum(ex.asset)).toBe(counts.manualAsset);
    expect(sum(ex.peripheral)).toBe(counts.manualPeripheral);
    // B 는 자기 것만: 업로드 1건(등록) → 빼면 0
    const b = await dash('badmin', 'excludeImports=true');
    expect(sum(b.trend.asset)).toBe(0);
    expect(sum((await dash('badmin')).trend.asset)).toBe(1);
    expect(JSON.stringify(b)).not.toMatch(/IM-|MAN-|WB-/);
  });

  it('부서 범위가 제한된 사용자: 범위 안의 이력만, 그 안에서 업로드를 뺀다', async () => {
    const all = (await dash('hruser')).trend;
    const ex = (await dash('hruser', 'excludeImports=true')).trend;
    expect(sum(all.asset)).toBe(counts.hrImported + counts.hrManual);
    expect(sum(ex.asset)).toBe(counts.hrManual);
    expect(sum(ex.peripheral)).toBe(0); // 주변기기는 모두 IT 부서
  });

  it('잘못된 값은 400, 대시보드 권한이 없으면 403', async () => {
    for (const qs of ['excludeImports=false', 'excludeImports=1', 'excludeImports=TRUE', 'excludeImports=', 'excludeImports=true&excludeImports=true', 'excludeimports=true']) {
      expect((await call(dashboardRoute, { cookie: cookie.admin, path: `/api/dashboard?${qs}` })).status, qs).toBe(400);
    }
    expect((await call(dashboardRoute, { cookie: cookie.nodash, path: '/api/dashboard?excludeImports=true' })).status).toBe(403);
  });
});
