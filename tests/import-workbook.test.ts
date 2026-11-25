// 통합 파일 업로드(직원·자산·주변기기 시트를 한 파일로): 양식, 한 트랜잭션·전부 아니면 전무, 시트별 권한, 격리, 여러 시트 읽기의 한도.
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as listAssets } from '@/app/api/assets/route';
import { GET as workbookTemplate, POST as importWorkbook } from '@/app/api/import/workbook/route';
import { closePool } from '@/lib/db/pool';
import { IMPORT_COLUMNS } from '@/lib/import/run';
import { readXlsx, readXlsxSheets, XLSX_LIMITS, XLSX_MULTI_LIMITS, XlsxError } from '@/lib/import/xlsx';
import { call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const cookie: Record<string, string> = {};
type Handler = (req: Request) => Promise<Response>;
type Row = (string | number | null)[];
type Sheet = { name: string; rows?: Row[]; xml?: string; target?: string; rid?: string };

const SHEETS = ['직원', '자산', '주변기기'];
const H = {
  persons: IMPORT_COLUMNS.persons.map((c) => c.header),
  assets: IMPORT_COLUMNS.assets.map((c) => c.header),
  peripherals: IMPORT_COLUMNS.peripherals.map((c) => c.header),
};

const one = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];
const count = async (table: string, companyId: string) => (await one(`SELECT count(*)::int AS n FROM app.${table} WHERE company_id = $1`, [companyId])).n as number;
const snapshot = async (companyId: string) => {
  const out: Record<string, number> = {};
  for (const t of ['person', 'asset', 'asset_txn', 'department', 'category', 'item_model', 'peripheral_stock', 'peripheral_txn', 'audit_log']) out[t] = await count(t, companyId);
  return out;
};

const col = (i: number) => (i < 26 ? '' : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function sheetXml(rows: Row[]): string {
  const body = rows
    .map((cells, r) => `<row r="${r + 1}">` + cells.map((v, c) =>
      v === null ? '' : typeof v === 'number' ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('') + '</row>')
    .join('');
  return `<worksheet><sheetData>${body}</sheetData></worksheet>`;
}

/** 이름 있는 시트들로 만든 시험용 엑셀. name 은 XML 에 그대로 들어간다(엔티티 시험용). */
function book(sheets: Sheet[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(`<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="${s.rid ?? `rId${i + 1}`}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${sheets.map((s, i) => (s.rid && s.rid !== `rId${i + 1}` ? '' : `<Relationship Id="rId${i + 1}" Target="${s.target ?? `worksheets/sheet${i + 1}.xml`}"/>`)).join('')}</Relationships>`),
  };
  sheets.forEach((s, i) => {
    if (s.target === undefined || s.target === `worksheets/sheet${i + 1}.xml`) files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(s.xml ?? sheetXml(s.rows ?? []));
  });
  return zipSync(files, { level: 9 });
}

async function upload(as: string, file: Uint8Array, mode: 'preview' | 'commit' = 'commit') {
  const res = await (importWorkbook as Handler)(
    new Request(`http://app.test/api/import/workbook?mode=${mode}`, {
      method: 'POST',
      headers: { host: 'app.test', origin: 'http://app.test', cookie: cookie[as]!, 'content-type': 'application/octet-stream' },
      body: file as BodyInit,
    }),
  );
  return { status: res.status, data: await res.json() };
}

const person = (no: string, name: string, dept: string | null = null): Row => [no, name, dept, null];
// 자산 열 순서: 자산태그, 카테고리, 제조사, 모델명, 시리얼번호, 관리부서, 위치, 보유자사번, 구매일, 구매가, 공급업체, 보증만료일, 상태
const asset = (tag: string, over: Partial<Record<number, string | number | null>> = {}): Row => {
  const row: Row = [tag, '노트북', 'Lenovo', 'WB-X1', null, null, null, null, null, null, null, null, null];
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v ?? null;
  return row;
};
const peripheral = (model: string, qty: number | string, dept: string | null = null): Row => ['마우스', 'Logi', model, dept, qty];

async function userWith(loginId: string, acl: [string, string][]): Promise<void> {
  const o = await owner();
  const userId = await makeUser(A.id, loginId, 'COMPANY_USER');
  const roleId = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [A.id, uniq('role')])).rows[0].id;
  for (const [r, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [roleId, r, op]);
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [userId, roleId, A.id]);
  cookie[loginId] = await sessionFor(A.code, loginId);
}

const ASSET_IMPORT: [string, string][] = [['asset.item', 'read'], ['asset.item', 'create'], ['asset.item', 'import']];

beforeAll(async () => {
  A = await makeCompany('WBA');
  B = await makeCompany('WBB');
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  await userWith('viewer', [['asset.item', 'read'], ['master.person', 'read']]);
  await userWith('assetonly', ASSET_IMPORT);
  await userWith('personsonly', [['master.person', 'read'], ['master.person', 'create'], ['master.person', 'import']]);
  // 직원 업로드 권한은 있지만 직원 등록 권한이 없다.
  await userWith('noPersonCreate', [...ASSET_IMPORT, ['master.person', 'import']]);
  await userWith('everything', [...ASSET_IMPORT, ['master.person', 'create'], ['master.person', 'import'], ['peripheral.receive', 'execute'], ['asset.assign', 'execute']]);
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('통합 양식', () => {
  it('시트 순서는 작성 안내·직원·자산·주변기기이고, 데이터 시트에는 종류별 양식과 같은 머리글만 있다', async () => {
    const res = await (workbookTemplate as Handler)(new Request('http://app.test/api/import/workbook', { headers: { host: 'app.test', cookie: cookie.admin! } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const workbookXml = new TextDecoder().decode(unzipSync(bytes)['xl/workbook.xml']);
    expect([...workbookXml.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1])).toEqual(['작성 안내', '직원', '자산', '주변기기']);

    const sheets = readXlsxSheets(bytes, SHEETS);
    const star = (kind: keyof typeof IMPORT_COLUMNS) => IMPORT_COLUMNS[kind].map((c) => (c.required ? `${c.header}*` : c.header));
    expect(sheets.get('직원')).toEqual([star('persons')]);
    expect(sheets.get('자산')).toEqual([star('assets')]);
    expect(sheets.get('주변기기')).toEqual([star('peripherals')]);

    // 첫 시트(작성 안내)에 열 설명, 상태 값, 처리 순서, 한도, 예시가 있다.
    const guide = readXlsx(bytes).flat().filter((c): c is string => typeof c === 'string').join('\n');
    for (const c of [...IMPORT_COLUMNS.persons, ...IMPORT_COLUMNS.assets, ...IMPORT_COLUMNS.peripherals]) expect(guide).toContain(c.hint);
    for (const v of ['재고', '사용중', '불량', '수리중', '분실', '퇴역', '폐기', '매각', '기증']) expect(guide).toContain(v);
    expect(guide).toContain('직원 → 자산 → 주변기기');
    expect(guide).toContain('2,000행');
    expect(guide).toContain('전부 아니면 전무');
    expect(guide).toContain('사용자 지정 필드');
    expect(guide).toContain('NB-2024-001'); // 자산 예시 행
    expect(guide).toContain('E1001');
    expect(guide).toContain('M650');

    // 받은 양식을 그대로 올리면 시트는 모두 건너뛰고 "자료 없음" 오류. 아무것도 반영하지 않는다.
    const before = await snapshot(A.id);
    const r = await upload('admin', bytes, 'commit');
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ kind: 'workbook', committed: false, totalRows: 0 });
    expect(r.data.sheets).toEqual([
      { kind: 'persons', sheet: '직원', totalRows: 0, skipped: true },
      { kind: 'assets', sheet: '자산', totalRows: 0, skipped: true },
      { kind: 'peripherals', sheet: '주변기기', totalRows: 0, skipped: true },
    ]);
    expect(r.data.errors[0].message).toContain('올릴 자료가 없습니다');
    expect(await snapshot(A.id)).toEqual(before);
  });

  it('업로드 권한이 없으면 양식도 업로드도 403', async () => {
    const res = await (workbookTemplate as Handler)(new Request('http://app.test/x', { headers: { host: 'app.test', cookie: cookie.viewer! } }));
    expect(res.status).toBe(403);
    // 직원 업로드 권한만 있는 계정도 통합 파일은 쓸 수 없다(라우트는 자산 업로드 권한을 선언한다).
    for (const who of ['viewer', 'personsonly']) {
      const r = await upload(who, book([{ name: '직원', rows: [H.persons, person(uniq('P'), '거부')] }]));
      expect(r.status, who).toBe(403);
    }
    expect(await count('person', A.id)).toBe(0);
  });
});

describe('통합 업로드', () => {
  it('직원 → 자산 → 주변기기 순서로 한 트랜잭션에서 처리한다: 자산의 보유자가 같은 파일의 직원이어도 된다. 미리보기는 아무것도 남기지 않는다', async () => {
    const no = uniq('WE');
    const tag1 = uniq('WA-');
    const tag2 = uniq('WA-');
    const mouse = uniq('WM');
    const dept = uniq('WDept');
    const file = book([
      { name: '작성 안내', rows: [['이 시트는 읽지 않는다'], H.assets, asset('GUIDE-EXAMPLE')] },
      { name: '직원', rows: [H.persons, person(no, '같은파일직원', dept), person(uniq('WE'), '둘째')] },
      { name: '자산', rows: [H.assets, asset(tag1, { 7: no.toLowerCase() }), asset(tag2, { 12: '재고' })] },
      { name: '주변기기', rows: [H.peripherals, peripheral(mouse, 7, dept), peripheral(mouse, '3', dept)] },
    ]);
    const before = await snapshot(A.id);
    const preview = await upload('admin', file, 'preview');
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({
      kind: 'workbook', committed: false, totalRows: 6, errors: [],
      sheets: [
        { kind: 'persons', sheet: '직원', totalRows: 2, skipped: false },
        { kind: 'assets', sheet: '자산', totalRows: 2, skipped: false },
        { kind: 'peripherals', sheet: '주변기기', totalRows: 2, skipped: false },
      ],
    });
    expect(preview.data.created.departments).toEqual([dept]);
    expect(preview.data.created.categories).toEqual(['노트북', '마우스']);
    expect(preview.data.created.models).toEqual(['Lenovo WB-X1', `Logi ${mouse}`]);
    expect(await snapshot(A.id)).toEqual(before);

    const done = await upload('admin', file);
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ committed: true, totalRows: 6, errors: [] });
    const a1 = await one('SELECT a.state, p.employee_no AS holder, p.name FROM app.asset a JOIN app.person p ON p.id = a.holder_person_id WHERE a.company_id = $1 AND a.asset_tag = $2', [A.id, tag1]);
    expect(a1).toEqual({ state: 'IN_USE', holder: no, name: '같은파일직원' });
    expect((await one('SELECT state FROM app.asset WHERE company_id = $1 AND asset_tag = $2', [A.id, tag2])).state).toBe('IN_STOCK');
    expect(await one("SELECT 1 AS x FROM app.asset WHERE company_id = $1 AND asset_tag = 'GUIDE-EXAMPLE'", [A.id])).toBeUndefined();
    const stock = await one('SELECT s.on_hand_qty, d.name AS dept FROM app.peripheral_stock s JOIN app.item_model m ON m.id = s.model_id JOIN app.department d ON d.id = s.department_id WHERE s.company_id = $1 AND m.name = $2', [A.id, mouse]);
    expect(stock).toEqual({ on_hand_qty: 10, dept });
    // 감사 기록은 시트마다 하나(그 시트의 리소스, 그 시트가 만든 기준 정보).
    const audits = (await (await owner()).query("SELECT resource, after FROM app.audit_log WHERE company_id = $1 AND action = 'IMPORT_COMMITTED' ORDER BY created_at, id", [A.id])).rows;
    expect(audits.map((a) => [a.resource, a.after.sheet, a.after.rows, a.after.workbook])).toEqual([
      ['master.person', '직원', 2, true],
      ['asset.item', '자산', 2, true],
      ['peripheral.receive', '주변기기', 2, true],
    ]);
    expect(audits[0].after.created.departments).toEqual([dept]);
    expect(audits[2].after.created).toEqual({ departments: [], categories: ['마우스'], models: [`Logi ${mouse}`] });
  });

  it('주변기기 시트의 오류 하나로 직원·자산도 모두 되돌린다. 오류는 시트와 행을 알려 준다', async () => {
    const before = await snapshot(A.id);
    const no = uniq('WE');
    const file = book([
      { name: '직원', rows: [H.persons, person(no, '되돌릴직원', uniq('RbDept'))] },
      { name: '자산', rows: [H.assets, asset(uniq('WA-'), { 7: no })] },
      { name: '주변기기', rows: [H.peripherals, peripheral(uniq('RbM'), 2), peripheral(uniq('RbM'), 0)] },
    ]);
    const r = await upload('admin', file);
    expect(r.status).toBe(422);
    expect(r.data.committed).toBe(false);
    expect(r.data.errors).toEqual([{ sheet: '주변기기', row: 3, message: '수량: 1 이상이어야 합니다.' }]);
    expect(await snapshot(A.id)).toEqual(before);
    expect(await one('SELECT 1 AS x FROM app.person WHERE company_id = $1 AND employee_no = $2', [A.id, no])).toBeUndefined();
  });

  it('형식 오류는 모든 시트에서 모아 시트·행과 함께 알려 주고, DB 처리 전에 멈춘다', async () => {
    const before = await snapshot(A.id);
    const r = await upload('admin', book([
      { name: '직원', rows: [H.persons, person(uniq('WE'), '정상'), [uniq('WE'), null, null, null]] },
      { name: '자산', rows: [H.assets, asset(uniq('WA-'), { 8: '2024-02-30' })] },
      { name: '주변기기', rows: [['카테고리', '이상한열'], ['마우스', 'x']] },
    ]), 'preview');
    expect(r.status).toBe(200);
    expect(r.data.errors).toEqual([
      { sheet: '직원', row: 3, message: '이름: 필수 항목입니다.' },
      { sheet: '자산', row: 2, message: '구매일: 날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)' },
      { sheet: '주변기기', row: 1, message: '알 수 없는 열입니다: 이상한열' },
      { sheet: '주변기기', row: 1, message: '필수 열이 없습니다: 제조사' },
      { sheet: '주변기기', row: 1, message: '필수 열이 없습니다: 모델명' },
      { sheet: '주변기기', row: 1, message: '필수 열이 없습니다: 수량' },
    ]);
    expect(await snapshot(A.id)).toEqual(before);
    // 보유자사번이 파일에도 DB 에도 없으면 자산 시트의 그 행 오류
    const missing = await upload('admin', book([{ name: '직원', rows: [H.persons, person(uniq('WE'), 'x')] }, { name: '자산', rows: [H.assets, asset(uniq('WA-')), asset(uniq('WA-'), { 7: 'NOBODY' })] }]));
    expect(missing.status).toBe(422);
    expect(missing.data.errors).toHaveLength(1);
    expect(missing.data.errors[0]).toMatchObject({ sheet: '자산', row: 3 });
    expect(missing.data.errors[0].message).toContain('등록되지 않은 사번');
    expect(await snapshot(A.id)).toEqual(before);
  });

  it('시트 이름은 앞뒤 공백을 떼고 찾고, 다른 시트는 무시하며, 일부 시트만 있어도 된다', async () => {
    const tag = uniq('WA-');
    const r = await upload('admin', book([{ name: 'Sheet1', rows: [['아무거나']] }, { name: '  자산 ', rows: [H.assets, asset(tag)] }]));
    expect(r.status).toBe(200);
    expect(r.data.sheets).toEqual([{ kind: 'assets', sheet: '자산', totalRows: 1, skipped: false }]);
    expect(await one('SELECT 1 AS x FROM app.asset WHERE company_id = $1 AND asset_tag = $2', [A.id, tag])).toBeDefined();
  });
});

describe('시트별 권한', () => {
  it('자산 업로드·등록 권한만 있으면: 직원 시트(자료 있음)가 있으면 그 시트를 알려 주며 거부, 자산 시트만 있으면 반영', async () => {
    const before = await snapshot(A.id);
    const withPersons = await upload('assetonly', book([{ name: '직원', rows: [H.persons, person(uniq('WE'), '권한없음')] }, { name: '자산', rows: [H.assets, asset(uniq('WA-'))] }]));
    expect(withPersons.status).toBe(403);
    expect(withPersons.data.error.message).toContain('직원 시트');
    expect(withPersons.data.error.message).toContain('업로드 권한');
    // 미리보기도 같다.
    expect((await upload('assetonly', book([{ name: '직원', rows: [H.persons, person(uniq('WE'), 'x')] }]), 'preview')).status).toBe(403);
    const withPeripherals = await upload('assetonly', book([{ name: '자산', rows: [H.assets, asset(uniq('WA-'))] }, { name: '주변기기', rows: [H.peripherals, peripheral('WB-M', 1)] }]));
    expect(withPeripherals.status).toBe(403);
    expect(withPeripherals.data.error.message).toContain('주변기기 시트');
    expect(await snapshot(A.id)).toEqual(before);

    // 자산 시트만: 이미 있는 모델·기본 부서로 반영된다.
    const tag = uniq('WA-');
    const ok = await upload('assetonly', book([{ name: '자산', rows: [H.assets, asset(tag)] }]));
    expect(ok.status).toBe(200);
    expect(ok.data.committed).toBe(true);
    // 직원 시트가 있어도 자료가 없으면(머리글만) 건너뛰고 권한을 묻지 않는다.
    const tag2 = uniq('WA-');
    const skipped = await upload('assetonly', book([{ name: '직원', rows: [H.persons] }, { name: '자산', rows: [H.assets, asset(tag2)] }]));
    expect(skipped.status).toBe(200);
    expect(skipped.data.sheets[0]).toEqual({ kind: 'persons', sheet: '직원', totalRows: 0, skipped: true });
    expect(await count('asset', A.id)).toBe(before.asset! + 2);
  });

  it('업로드 권한이 있어도 그 시트의 등록·배정 권한이 없으면 시트를 알려 주며 거부하고 아무것도 반영하지 않는다', async () => {
    const before = await snapshot(A.id);
    const noCreate = await upload('noPersonCreate', book([{ name: '직원', rows: [H.persons, person(uniq('WE'), 'x')] }, { name: '자산', rows: [H.assets, asset(uniq('WA-'))] }]));
    expect(noCreate.status).toBe(403);
    expect(noCreate.data.error.message).toContain('직원 시트');
    expect(noCreate.data.error.message).toContain('등록 권한');
    // 배정 권한이 없는데 보유자사번을 적음: 자산 시트 1행 오류
    const no = uniq('WE');
    await upload('admin', book([{ name: '직원', rows: [H.persons, person(no, '보유자')] }]));
    const noAssign = await upload('assetonly', book([{ name: '자산', rows: [H.assets, asset(uniq('WA-'), { 7: no })] }]));
    expect(noAssign.status).toBe(422);
    expect(noAssign.data.errors).toEqual([{ sheet: '자산', row: 1, message: expect.stringContaining('배정 권한') }]);
    expect(await count('asset', A.id)).toBe(before.asset);
  });

  it('필요한 권한을 모두 가진 기업 사용자는 세 시트를 함께 올릴 수 있다', async () => {
    const no = uniq('WE');
    const tag = uniq('WA-');
    const r = await upload('everything', book([
      { name: '직원', rows: [H.persons, person(no, '전부권한')] },
      { name: '자산', rows: [H.assets, asset(tag, { 7: no })] },
      { name: '주변기기', rows: [H.peripherals, peripheral('WB-M', 1)] },
    ]));
    // 주변기기 모델 WB-M 은 아직 없고 이 계정은 모델 등록 권한이 없다: 주변기기 2행 오류로 전부 되돌린다.
    expect(r.status).toBe(422);
    expect(r.data.errors).toEqual([{ sheet: '주변기기', row: 2, message: expect.stringContaining('모델 등록 권한') }]);
    expect(await one('SELECT 1 AS x FROM app.person WHERE company_id = $1 AND employee_no = $2', [A.id, no])).toBeUndefined();
    const ok = await upload('everything', book([{ name: '직원', rows: [H.persons, person(no, '전부권한')] }, { name: '자산', rows: [H.assets, asset(tag, { 7: no })] }]));
    expect(ok.data.committed).toBe(true);
  });
});

describe('기업 격리', () => {
  it('다른 기업의 자료는 그대로이고, 다른 기업은 올린 자료를 볼 수 없으며, 다른 기업의 직원을 보유자로 쓸 수 없다', async () => {
    const no = uniq('WE');
    const tag = uniq('WA-');
    const beforeB = await snapshot(B.id);
    const r = await upload('admin', book([{ name: '직원', rows: [H.persons, person(no, '격리직원')] }, { name: '자산', rows: [H.assets, asset(tag, { 7: no })] }]));
    expect(r.data.committed).toBe(true);
    expect(await snapshot(B.id)).toEqual(beforeB);

    const seenByB = await call(listAssets as Handler, { path: `/api/assets?q=${encodeURIComponent(tag)}`, cookie: cookie.badmin });
    expect(seenByB.status).toBe(200);
    expect(seenByB.data.total).toBe(0);
    const seenByA = await call(listAssets as Handler, { path: `/api/assets?q=${encodeURIComponent(tag)}`, cookie: cookie.admin });
    expect(seenByA.data.total).toBe(1);

    // B 가 A 의 사번을 보유자로 적으면 없는 사번이다. 같은 태그는 B 에서 따로 쓸 수 있다.
    const cross = await upload('badmin', book([{ name: '자산', rows: [H.assets, asset(tag, { 7: no })] }]));
    expect(cross.status).toBe(422);
    expect(cross.data.errors[0]).toMatchObject({ sheet: '자산', row: 2 });
    expect(await snapshot(B.id)).toEqual(beforeB);
    expect((await upload('badmin', book([{ name: '자산', rows: [H.assets, asset(tag)] }]))).data.committed).toBe(true);
    expect(await count('asset', B.id)).toBe(1);
  });
});

describe('파일 형식과 한도', () => {
  it('모든 시트를 합친 자료 행이 합계 한도를 넘으면 DB 처리 전에 거부한다(시트마다는 한도 안이어도)', async () => {
    const before = await count('person', A.id);
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => person(`${prefix}${i}`, `이름${i}`));
    const res = await upload('admin', book([
      { name: '직원', rows: [H.persons, ...many(2000, uniq('CAPA'))] },
      { name: '주변기기', rows: [H.peripherals, ...Array.from({ length: 1001 }, (_, i) => peripheral(`CAP-${i}`, 1))] },
    ]));
    expect(res.status).toBe(422);
    expect(res.data.committed).toBe(false);
    expect(res.data.totalRows).toBe(3001);
    expect(res.data.errors[0].message).toContain('3,000행까지');
    expect(await count('person', A.id)).toBe(before);
  });

  it('세 시트가 하나도 없으면 400, 깨진 파일은 400', async () => {
    const none = await upload('admin', book([{ name: '작성 안내', rows: [['x']] }, { name: 'Employees', rows: [H.persons, person('1', 'x')] }]));
    expect(none.status).toBe(400);
    expect(none.data.error.message).toContain('시트가 없습니다');
    expect((await upload('admin', strToU8('not a zip'))).status).toBe(400);
    // 시트 목록(workbook.xml)이 없는 파일
    expect((await upload('admin', zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheetXml([H.persons])) }))).status).toBe(400);
  });

  it('같은 이름(공백을 뗀 뒤)의 시트가 둘이면 거부한다', async () => {
    const r = await upload('admin', book([{ name: '직원', rows: [H.persons, person(uniq('WE'), 'a')] }, { name: ' 직원', rows: [H.persons, person(uniq('WE'), 'b')] }]));
    expect(r.status).toBe(400);
    expect(r.data.error.message).toContain('같은 이름의 시트');
  });

  const reads = (file: Uint8Array): string => {
    try {
      return [...readXlsxSheets(file, SHEETS).keys()].join(',');
    } catch (err) {
      if (err instanceof XlsxError) return `rejected: ${err.message}`;
      throw err;
    }
  };

  it('시트 이름의 엔티티를 풀고, 아주 긴 이름은 무시하며, 관계 경로가 xl/worksheets 밖이면 거부한다', () => {
    const x = sheetXml([['a']]);
    // &#51649;&#50896; = 직원
    expect(reads(book([{ name: '&#51649;&#50896;', xml: x }, { name: '&#xC790;&#xC0B0;', xml: x }]))).toBe('직원,자산');
    expect(reads(book([{ name: '직원' + ' x'.repeat(5000), xml: x }]))).toBe('');
    // 절대 경로(/xl/worksheets/...)는 받는다.
    const abs = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="자산" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="/xl/worksheets/a.xml"/></Relationships>'),
      'xl/worksheets/a.xml': strToU8(x),
    });
    expect(reads(abs)).toBe('자산');
    for (const target of ['../xl/sharedStrings.xml', 'sharedStrings.xml', 'worksheets/../sharedStrings.xml', 'worksheets/./a.xml', 'worksheets\\..\\a.xml', '/etc/passwd', 'worksheets//a.xml', 'worksheets/a%2e.xml']) {
      const file = zipSync({
        'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="자산" sheetId="1" r:id="rId1"/></sheets></workbook>'),
        'xl/_rels/workbook.xml.rels': strToU8(`<Relationships><Relationship Id="rId1" Target="${target}"/></Relationships>`),
        'xl/sharedStrings.xml': strToU8('<sst><si><t>a</t></si></sst>'),
        'xl/worksheets/a.xml': strToU8(x),
      });
      expect(reads(file), target).toMatch(/^rejected/);
    }
    // 관계 ID 가 없거나, 두 시트가 같은 파일을 가리키거나, 관계 ID 가 두 번 나오면 거부한다.
    expect(reads(book([{ name: '직원', xml: x, rid: 'rIdMissing' }]))).toMatch(/^rejected/);
    const same = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="직원" sheetId="1" r:id="rId1"/><sheet name="자산" sheetId="2" r:id="rId2"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/a.xml"/><Relationship Id="rId2" Target="worksheets/A.xml"/></Relationships>'),
      'xl/worksheets/a.xml': strToU8(x),
    });
    expect(reads(same)).toMatch(/^rejected/);
    const dupId = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="직원" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/a.xml"/><Relationship Id="rId1" Target="worksheets/b.xml"/></Relationships>'),
      'xl/worksheets/a.xml': strToU8(x),
      'xl/worksheets/b.xml': strToU8(x),
    });
    expect(reads(dupId)).toMatch(/^rejected/);
    // DOCTYPE 이 든 시트 목록은 거부한다.
    expect(reads(zipSync({ 'xl/workbook.xml': strToU8('<!DOCTYPE x [<!ENTITY a "직원">]><workbook><sheets><sheet name="&a;" r:id="rId1"/></sheets></workbook>') }))).toMatch(/^rejected/);
  });

  it('시트마다의 한도 안이어도 시트를 모두 합친 크기·행 요소 수가 합계 한도를 넘으면 거부한다', async () => {
    const MB = 1024 * 1024;
    const padded = (mb: number) => `<worksheet>${' '.repeat(mb * MB)}<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
    expect(9 * 2).toBeLessThan(XLSX_MULTI_LIMITS.sheetBytesTotal / MB);
    expect(9 * 3).toBeGreaterThan(XLSX_MULTI_LIMITS.sheetBytesTotal / MB);
    expect(9).toBeLessThan(XLSX_LIMITS.partBytes / MB);
    const two = book([{ name: '직원', xml: padded(9) }, { name: '자산', xml: padded(9) }]);
    const three = book([{ name: '직원', xml: padded(9) }, { name: '자산', xml: padded(9) }, { name: '주변기기', xml: padded(9) }]);
    expect(three.length).toBeLessThan(XLSX_LIMITS.fileBytes);
    expect(reads(two)).toBe('직원,자산');
    expect(reads(three)).toMatch(/^rejected: .*합쳐/);
    const r = await upload('admin', three, 'preview');
    expect(r.status).toBe(400);
    expect(r.data.error.message).toContain('합쳐');

    // 빈 행 요소: 시트 하나에 16,000개는 받지만, 두 시트를 합쳐 32,000개(합계 30,000 초과)는 거부한다.
    const blankRows = (n: number) => `<worksheet><sheetData>${Array.from({ length: n }, (_, i) => `<row r="${i + 1}"/>`).join('')}</sheetData></worksheet>`;
    expect(16_000).toBeLessThan(XLSX_LIMITS.rowElements);
    expect(32_000).toBeGreaterThan(XLSX_MULTI_LIMITS.rowElementsTotal);
    expect(reads(book([{ name: '직원', xml: blankRows(16_000) }]))).toBe('직원');
    expect(reads(book([{ name: '직원', xml: blankRows(16_000) }, { name: '자산', xml: blankRows(16_000) }]))).toMatch(/^rejected: 자산 시트: 행이 너무 많습니다/);
    // 값이 있는 행 2,000행 한도는 시트마다 따로 센다.
    const filled = (n: number) => [['h'], ...Array.from({ length: n }, (_, i) => [`v${i}`])];
    expect(reads(book([{ name: '직원', rows: filled(2000) }, { name: '자산', rows: filled(2000) }, { name: '주변기기', rows: filled(2000) }]))).toBe('직원,자산,주변기기');
    expect(reads(book([{ name: '직원', rows: filled(2000) }, { name: '자산', rows: filled(2001) }]))).toMatch(/^rejected: 자산 시트: 행이 너무 많습니다/);
    // 찾는 이름이 아닌 시트(안내 시트 등)는 풀지 않는다: 압축 폭탄이어도 읽기에 영향이 없다.
    const bombGuide = book([{ name: '작성 안내', xml: '<worksheet>' + ' '.repeat(XLSX_LIMITS.partBytes + 1) + '</worksheet>' }, { name: '자산', rows: [['a']] }]);
    expect(reads(bombGuide)).toBe('자산');
  });

  it('합계 한도 크기의 최악 입력도 3초 안에 읽거나 거부한다', () => {
    const M = 1024 * 1024;
    const t = performance.now();
    // 시트마다 12MB 의 빈 칸 태그(합계 24MB 를 넘기 직전까지)
    const cells = (mb: number) => '<worksheet><sheetData><row r="1">' + '<c/>'.repeat((mb * M) / 4 - 20) + '</row></sheetData></worksheet>';
    const out = reads(book([{ name: '직원', xml: cells(11) }, { name: '자산', xml: cells(11) }, { name: '주변기기', xml: cells(1) }]));
    expect(out.startsWith('rejected') || out === '직원,자산,주변기기').toBe(true);
    expect(performance.now() - t).toBeLessThan(3000);
  });
});
