// 3단계: 엑셀 업로드. 파일 읽기의 한계, 미리보기 = 반영, 전부 아니면 전무, 권한·범위·격리.
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as assetsTemplate, POST as importAssets } from '@/app/api/import/assets/route';
import { POST as importPeripherals } from '@/app/api/import/peripherals/route';
import { GET as personsTemplate, POST as importPersons } from '@/app/api/import/persons/route';
import { closePool } from '@/lib/db/pool';
import { IMPORT_COLUMNS } from '@/lib/import/run';
import { readXlsx, serialToIsoDate, writeXlsx, XLSX_LIMITS, XlsxError } from '@/lib/import/xlsx';
import { closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};
type Handler = (req: Request) => Promise<Response>;
type Row = (string | number | null)[];

const one = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];
const count = async (table: string, companyId: string) => (await one(`SELECT count(*)::int AS n FROM app.${table} WHERE company_id = $1`, [companyId])).n as number;

/** 숫자는 숫자 셀로, 글자는 글자 셀로 넣은 시험용 엑셀. */
function xlsx(rows: Row[]): Uint8Array {
  const col = (i: number) => (i < 26 ? '' : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = rows
    .map((cells, r) => `<row r="${r + 1}">` + cells.map((v, c) =>
      v === null ? '' : typeof v === 'number' ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('') + '</row>')
    .join('');
  return zipSync({
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${body}</sheetData></worksheet>`),
  });
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
// 자산 열 순서: 자산태그, 카테고리, 제조사, 모델명, 시리얼번호, 관리부서, 위치, 보유자사번, 구매일, 구매가, 공급업체, 보증만료일
const asset = (tag: string, over: Partial<Record<number, string | number | null>> = {}): Row => {
  const row: Row = [tag, '노트북', 'Lenovo', 'X1', null, null, null, null, null, null, null, null];
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v ?? null;
  return row;
};

async function userWith(loginId: string, acl: [string, string][], deptIds: string[] = []): Promise<void> {
  const o = await owner();
  const userId = await makeUser(A.id, loginId, 'COMPANY_USER');
  const roleId = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [A.id, uniq('role')])).rows[0].id;
  for (const [r, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [roleId, r, op]);
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [userId, roleId, A.id]);
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [userId, d, A.id]);
  cookie[loginId] = await sessionFor(A.code, loginId);
}

beforeAll(async () => {
  A = await makeCompany('IMPA');
  B = await makeCompany('IMPB');
  const o = await owner();
  id.it = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A.id])).rows[0].id;
  id.hr = (await o.query("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [A.id])).rows[0].id;
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  await userWith('viewer', [['asset.item', 'read'], ['master.person', 'read']]);
  // 자산 업로드만 가능: 기준 정보 등록·배정·제한 필드 권한 없음
  await userWith('importer', [['asset.item', 'read'], ['asset.item', 'create'], ['asset.item', 'import']]);
  await userWith('hrimporter', [['asset.item', 'read'], ['asset.item', 'create'], ['asset.item', 'import'], ['asset.assign', 'execute'], ['master.model', 'create'], ['master.category', 'create']], [id.hr!]);
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('엑셀 읽기', () => {
  it('양식을 내려받아 다시 읽으면 머리글이 그대로 나온다', async () => {
    const res = await assetsTemplate(new Request('http://app.test/api/import/assets', { headers: { host: 'app.test', cookie: cookie.admin! } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const rows = readXlsx(new Uint8Array(await res.arrayBuffer()));
    expect(rows[0]!.map((h) => String(h).replace('*', ''))).toEqual(H.assets);
    expect((await personsTemplate(new Request('http://app.test/x', { headers: { host: 'app.test', cookie: cookie.viewer! } }))).status).toBe(403);
  });

  it('공유 문자열, 서식이 섞인 글, 발음 표기, 엔티티, 빈 칸, 수식 결과를 읽는다', () => {
    const file = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="b" sheetId="2" r:id="rId7"/><sheet name="a" sheetId="1" r:id="rId3"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId3" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="worksheets/second.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>plain</t></si><si><r><t>ri</t></r><r><rPr><b/></rPr><t xml:space="preserve">ch &amp; &lt;b&gt;</t></r><rPh><t>PHONETIC</t></rPh></si><si/><si><t>&#44608;&#x1F600;&bogus;</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1"><v>999</v></c></row></sheetData></worksheet>'),
      'xl/worksheets/second.xml': strToU8(
        '<worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>3</v></c></row>' +
          '<row r="3"><c r="B3"><f>1+1</f><v>2</v></c><c r="C3" t="str"><f>A1</f><v>calc</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="e"><v>#N/A</v></c><c r="F3" s="4"/><c r="G3" t="s"><v>2</v></c></row>' +
          '</sheetData></worksheet>',
      ),
    });
    // 첫 시트는 파일 이름이 아니라 workbook.xml 의 순서로 정한다.
    expect(readXlsx(file)).toEqual([
      ['plain', 'rich & <b>', null, '김😀&bogus;'],
      [],
      [null, 2, 'calc', true, null, null, null],
    ]);
    expect(serialToIsoDate(45292)).toBe('2024-01-01');
    expect(serialToIsoDate(61)).toBe('1900-03-01');
    expect(serialToIsoDate(-5)).toBeNull();
  });

  it('엑셀이 아닌 파일, 깨진 파일, 한도를 넘는 파일은 거부한다', () => {
    const bad = (bytes: Uint8Array) => {
      try {
        readXlsx(bytes);
      } catch (err) {
        return err instanceof XlsxError;
      }
      return false;
    };
    expect(bad(strToU8('a,b,c\n1,2,3'))).toBe(true);
    expect(bad(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6]))).toBe(true);
    expect(bad(zipSync({ 'readme.txt': strToU8('x') }))).toBe(true);
    expect(bad(new Uint8Array(XLSX_LIMITS.fileBytes + 1).fill(0x50))).toBe(true);
    expect(bad(xlsx(Array.from({ length: XLSX_LIMITS.rows + 1 }, (_, i) => [`r${i}`])))).toBe(true);
    expect(bad(xlsx([Array.from({ length: XLSX_LIMITS.columns + 1 }, () => 'y')]))).toBe(true);
    expect(bad(xlsx([Array.from({ length: XLSX_LIMITS.columns }, () => 'y')]))).toBe(false);
    expect(bad(xlsx([['x'.repeat(XLSX_LIMITS.cellChars + 1)]]))).toBe(true);
    // 압축 폭탄: 풀면 한도를 넘는 시트는 풀기 전에 거부한다.
    const bomb = zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(XLSX_LIMITS.partBytes + 1) }, { level: 9 });
    expect(bomb.length).toBeLessThan(XLSX_LIMITS.fileBytes);
    expect(bad(bomb)).toBe(true);
  });

  it('zip 목록의 이상(같은 이름 두 번, 지나치게 많은 항목, 암호화 표시)과 글자 목록 한도 초과를 거부한다', () => {
    const rejects = (bytes: Uint8Array) => {
      try {
        readXlsx(bytes);
        return false;
      } catch (err) {
        return err instanceof XlsxError;
      }
    };
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';
    const ok = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet) });
    expect(rejects(ok)).toBe(false);
    // 대소문자만 다른 같은 이름
    expect(rejects(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet), 'xl/worksheets/SHEET1.xml': strToU8(sheet) }))).toBe(true);
    // 항목 수 한도
    const many: Record<string, Uint8Array> = { 'xl/worksheets/sheet1.xml': strToU8(sheet) };
    for (let i = 0; i < XLSX_LIMITS.zipEntries; i++) many[`junk/${i}.txt`] = new Uint8Array(0);
    expect(rejects(zipSync(many, { level: 0 }))).toBe(true);
    // 암호화 표시(목록의 플래그 비트 0)
    const encrypted = ok.slice();
    for (let i = encrypted.length - 22; i >= 0; i--) {
      if (encrypted[i] === 0x50 && encrypted[i + 1] === 0x4b && encrypted[i + 2] === 1 && encrypted[i + 3] === 2) {
        encrypted[i + 8] = encrypted[i + 8]! | 1;
        break;
      }
    }
    expect(rejects(encrypted)).toBe(true);
    // 글자 목록 개수 한도
    const shared = '<sst>' + '<si/>'.repeat(XLSX_LIMITS.sharedStrings + 1) + '</sst>';
    expect(rejects(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet), 'xl/sharedStrings.xml': strToU8(shared) }))).toBe(true);
  });

  it('속성은 작은따옴표·공백이 있어도 읽고, 맞지 않는 파일은 값을 조용히 버리지 않고 거부한다', () => {
    const wrap = (sheet: string, shared = '<sst><si><t>alpha</t></si><si><t>gamma</t></si></sst>') =>
      zipSync({ 'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`), 'xl/SharedStrings.xml': strToU8(shared) });
    // 작은따옴표, = 주변 공백, 대소문자가 다른 글자 목록 파일 이름
    expect(readXlsx(wrap(`<row r = '1'><c r='A1' t = "s"><v>0</v></c><c t='s' r="C1"><v>1</v></c></row>`))).toEqual([['alpha', null, 'gamma']]);
    const rejects = (sheet: string) => {
      try {
        readXlsx(wrap(sheet));
        return false;
      } catch (err) {
        return err instanceof XlsxError;
      }
    };
    expect(rejects('<row r="1"><c r="A1" t="s"><v>7</v></c></row>')).toBe(true); // 없는 글자 번호
    expect(rejects('<row r="1"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row>')).toBe(true); // 같은 칸 두 번
    expect(rejects('<row r="2"><c r="A2"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>')).toBe(true); // 같은 행 두 번
    expect(rejects('<row r="1"><c r="A1"><v>1</v></c>')).toBe(true); // 행이 닫히지 않고 끝남
  });

  it('쓰기: 특수 문자가 든 글도 그대로 돌아온다', () => {
    const rows = [['a&b', '<tag>', '"q"', '한글 값'], ['', 'x']];
    expect(readXlsx(writeXlsx([{ name: 's&1', rows }]))).toEqual([['a&b', '<tag>', '"q"', '한글 값'], [null, 'x']]);
  });
});

describe('직원 업로드', () => {
  it('미리보기는 아무것도 남기지 않고, 반영하면 직원과 없는 부서가 만들어진다', async () => {
    const file = xlsx([H.persons, [1001, '김하나', 'HR', 'hana@example.com'], ['E-2', '이두리', '신규부서', null], [null, '박세찌', null, null], [null, null, null, null]]);
    const before = await count('person', A.id);
    const preview = await upload(importPersons as Handler, 'admin', file, 'preview');
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ committed: false, totalRows: 3, errors: [], created: { departments: ['신규부서'] } });
    expect(await count('person', A.id)).toBe(before);
    expect(await one("SELECT 1 AS x FROM app.department WHERE company_id = $1 AND name = '신규부서'", [A.id])).toBeUndefined();

    const done = await upload(importPersons as Handler, 'admin', file);
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ committed: true, totalRows: 3, created: { departments: ['신규부서'] } });
    expect(await count('person', A.id)).toBe(before + 3);
    // 숫자로 저장된 사번은 글자로 들어간다.
    expect(await one("SELECT name, email, (SELECT name FROM app.department d WHERE d.id = p.department_id) AS dept FROM app.person p WHERE company_id = $1 AND employee_no = '1001'", [A.id]))
      .toEqual({ name: '김하나', email: 'hana@example.com', dept: 'HR' });
    expect((await one("SELECT count(*)::int AS n FROM app.audit_log WHERE company_id = $1 AND action = 'IMPORT_COMMITTED'", [A.id])).n).toBe(1);

    // 같은 파일을 다시 올리면 사번이 겹쳐 전체가 거부된다.
    const again = await upload(importPersons as Handler, 'admin', file);
    expect(again.status).toBe(422);
    expect(again.data.committed).toBe(false);
    expect(again.data.errors.map((e: { row: number }) => e.row)).toEqual([2, 3]);
    expect(await count('person', A.id)).toBe(before + 3);
  });

  it('한 행이라도 오류가 있으면 전체가 반영되지 않는다(파일 안의 중복 포함)', async () => {
    const before = await count('person', A.id);
    const dupNo = uniq('D');
    const r = await upload(importPersons as Handler, 'admin', xlsx([H.persons, [uniq('OK'), '정상', null, null], [dupNo, '중복1', null, null], [dupNo.toLowerCase(), '중복2', '또다른부서', null], [null, null, 'HR', null]]));
    expect(r.status).toBe(422);
    expect(r.data.errors).toEqual([{ row: 5, message: '이름: 필수 항목입니다.' }]); // 형식 오류가 있으면 DB 처리 전에 멈춘다
    const r2 = await upload(importPersons as Handler, 'admin', xlsx([H.persons, [uniq('OK'), '정상', null, null], [dupNo, '중복1', null, null], [dupNo.toLowerCase(), '중복2', '또다른부서', null]]));
    expect(r2.status).toBe(422);
    expect(r2.data.errors.map((e: { row: number }) => e.row)).toEqual([4]);
    expect(await count('person', A.id)).toBe(before);
    expect(await one("SELECT 1 AS x FROM app.department WHERE company_id = $1 AND name = '또다른부서'", [A.id])).toBeUndefined();
  });

  it('머리글이 틀리면 어떤 열이 문제인지 알려 준다', async () => {
    const r = await upload(importPersons as Handler, 'admin', xlsx([['사번', '성명', '부서'], ['1', 'x', null]]), 'preview');
    expect(r.data.errors.map((e: { message: string }) => e.message)).toEqual(['알 수 없는 열입니다: 성명', '필수 열이 없습니다: 이름']);
    const empty = await upload(importPersons as Handler, 'admin', xlsx([H.persons]), 'preview');
    expect(empty.data.errors[0].message).toBe('올릴 자료가 없습니다.');
    const notExcel = await upload(importPersons as Handler, 'admin', strToU8('이름\n홍길동'));
    expect(notExcel.status).toBe(400);
  });
});

describe('자산 업로드', () => {
  it('모델·카테고리를 자동으로 만들고, 보유자가 있으면 배정된 상태로 등록하며, 이력이 남는다', async () => {
    await upload(importPersons as Handler, 'admin', xlsx([H.persons, ['H-1', '보유자', null, null]]));
    const t1 = uniq('IA-');
    const t2 = uniq('IA-');
    const file = xlsx([
      H.assets.map((h, i) => (i === 0 ? `${h} *` : h)), // 머리글의 별표·공백은 무시한다
      asset(t1, { 4: 'SN-1', 5: 'HR', 6: '3층', 7: 'h-1', 8: 45292, 9: '1,250,000', 10: '공급사', 11: '2027.1.5' }),
      asset(t2, { 3: 'T14' }),
    ]);
    const preview = await upload(importAssets as Handler, 'admin', file, 'preview');
    expect(preview.data).toMatchObject({ committed: false, errors: [], created: { categories: ['노트북'], models: ['Lenovo X1', 'Lenovo T14'] } });
    expect(await count('asset', A.id)).toBe(0);
    expect(await count('item_model', A.id)).toBe(0);

    const done = await upload(importAssets as Handler, 'admin', file);
    expect(done.data).toMatchObject({ committed: true, totalRows: 2 });
    const a1 = await one(
      `SELECT a.id, a.state, a.serial_number, a.location, a.purchase_date::text AS pd, a.purchase_price::float8 AS price, a.supplier, a.warranty_end::text AS we,
              d.name AS dept, p.employee_no AS holder, m.name AS model, c.name AS category, c.kind
         FROM app.asset a JOIN app.department d ON d.id = a.department_id JOIN app.item_model m ON m.id = a.model_id JOIN app.category c ON c.id = m.category_id
         LEFT JOIN app.person p ON p.id = a.holder_person_id WHERE a.company_id = $1 AND a.asset_tag = $2`,
      [A.id, t1],
    );
    expect(a1).toMatchObject({ state: 'IN_USE', serial_number: 'SN-1', location: '3층', pd: '2024-01-01', price: 1250000, supplier: '공급사', we: '2027-01-05', dept: 'HR', holder: 'H-1', model: 'X1', category: '노트북', kind: 'ASSET' });
    const types = (await (await owner()).query('SELECT type FROM app.asset_txn WHERE asset_id = $1 ORDER BY created_at, seq', [a1.id])).rows.map((r) => r.type);
    expect(types).toEqual(['REGISTER', 'ASSIGN']);
    const a2 = await one("SELECT a.state, a.substate, d.is_default FROM app.asset a JOIN app.department d ON d.id = a.department_id WHERE a.company_id = $1 AND a.asset_tag = $2", [A.id, t2]);
    expect(a2).toEqual({ state: 'IN_STOCK', substate: 'AVAILABLE', is_default: true });
  });

  it('행 오류를 모두 모아 알려 주고 아무것도 반영하지 않는다', async () => {
    const existing = uniq('IA-');
    await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(existing)]));
    const before = await count('asset', A.id);
    const dup = uniq('IA-');
    const r = await upload(importAssets as Handler, 'admin', xlsx([
      H.assets,
      asset(uniq('IA-')), // 2: 정상
      asset(existing.toLowerCase()), // 3: 이미 있는 태그
      asset(dup), // 4: 정상
      asset(dup), // 5: 파일 안의 중복
      asset(uniq('IA-'), { 7: 'NOPE' }), // 6: 없는 사번
      asset(uniq('IA-'), { 1: '마우스류', 2: 'Logi', 3: 'M-per' }), // 7: 정상(새 카테고리)
      asset(uniq('IA-'), { 8: '2024-02-30' }), // 8: 없는 날짜 → 형식 오류
    ]));
    expect(r.status).toBe(422);
    expect(r.data.errors).toEqual([{ row: 8, message: '구매일: 날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)' }]);
    const r2 = await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(uniq('IA-')), asset(existing.toLowerCase()), asset(dup), asset(dup), asset(uniq('IA-'), { 7: 'NOPE' }), asset(uniq('IA-'), { 9: -5 })]));
    expect(r2.data.errors.map((e: { row: number }) => e.row)).toEqual([3, 5, 6, 7]);
    expect(await count('asset', A.id)).toBe(before);
  });

  it('주변기기용으로 이미 있는 모델·카테고리는 자산으로 올릴 수 없다', async () => {
    await upload(importPeripherals as Handler, 'admin', xlsx([H.peripherals, ['키보드', 'Logi', 'K380', null, 5]]));
    const r = await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(uniq('IA-'), { 1: '키보드', 2: 'Logi', 3: 'K380' }), asset(uniq('IA-'), { 1: '키보드', 2: 'Other', 3: 'New' })]));
    expect(r.status).toBe(422);
    expect(r.data.errors.map((e: { row: number }) => e.row)).toEqual([2, 3]);
  });

  it('업로드 권한만으로는 기준 정보 자동 생성, 제한 필드 입력, 보유자 배정을 할 수 없다', async () => {
    const before = await count('asset', A.id);
    const newModel = await upload(importAssets as Handler, 'importer', xlsx([H.assets, asset(uniq('IA-'), { 3: uniq('NewModel') })]));
    expect(newModel.status).toBe(422);
    expect(newModel.data.errors[0].message).toContain('모델 등록 권한');
    const newDept = await upload(importAssets as Handler, 'importer', xlsx([H.assets, asset(uniq('IA-'), { 5: uniq('NewDept') })]));
    expect(newDept.data.errors[0].message).toContain('부서 등록 권한');
    const price = await upload(importAssets as Handler, 'importer', xlsx([H.assets, asset(uniq('IA-'), { 9: 100 })]));
    expect(price.data.errors[0].message).toContain('구매가');
    const supplier = await upload(importAssets as Handler, 'importer', xlsx([H.assets, asset(uniq('IA-'), { 10: 'S' })]));
    expect(supplier.data.errors[0].message).toContain('공급업체');
    const holder = await upload(importAssets as Handler, 'importer', xlsx([H.assets, asset(uniq('IA-'), { 7: 'H-1' })]));
    expect(holder.data.errors[0].message).toContain('배정 권한');
    expect(await count('asset', A.id)).toBe(before);
    expect(await one('SELECT 1 AS x FROM app.department WHERE company_id = $1 AND name LIKE $2', [A.id, 'NewDept%'])).toBeUndefined();
    // 이미 있는 모델·기본 부서로는 올릴 수 있다.
    expect((await upload(importAssets as Handler, 'importer', xlsx([H.assets, asset(uniq('IA-'))]))).data.committed).toBe(true);
    // 업로드 권한이 없으면 403.
    expect((await upload(importAssets as Handler, 'viewer', xlsx([H.assets, asset(uniq('IA-'))]))).status).toBe(403);
  });

  it('부서 범위가 제한된 사용자는 자기 범위의 부서로만 올릴 수 있다', async () => {
    const outside = await upload(importAssets as Handler, 'hrimporter', xlsx([H.assets, asset(uniq('IA-'))])); // 기본 부서(IT)는 범위 밖
    expect(outside.status).toBe(422);
    const it = await upload(importAssets as Handler, 'hrimporter', xlsx([H.assets, asset(uniq('IA-'), { 5: 'IT' })]));
    expect(it.status).toBe(422);
    const newDept = await upload(importAssets as Handler, 'hrimporter', xlsx([H.assets, asset(uniq('IA-'), { 5: uniq('Scoped') })]));
    expect(newDept.status).toBe(422); // 범위가 제한된 사용자는 부서를 만들 수 없다
    const tag = uniq('IA-');
    expect((await upload(importAssets as Handler, 'hrimporter', xlsx([H.assets, asset(tag, { 5: 'hr' })]))).data.committed).toBe(true);
    expect((await one('SELECT department_id FROM app.asset WHERE company_id = $1 AND asset_tag = $2', [A.id, tag])).department_id).toBe(id.hr);
  });

  it('다른 기업에는 아무 영향이 없고, 같은 태그·사번을 다른 기업이 쓸 수 있다', async () => {
    const tag = uniq('IA-');
    await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(tag, { 7: 'H-1' })]));
    // B 에는 H-1 직원이 없다: A 의 직원을 참조할 수 없다.
    const cross = await upload(importAssets as Handler, 'badmin', xlsx([H.assets, asset(tag, { 7: 'H-1' })]));
    expect(cross.status).toBe(422);
    expect(await count('asset', B.id)).toBe(0);
    expect(await count('category', B.id)).toBe(0);
    expect((await upload(importAssets as Handler, 'badmin', xlsx([H.assets, asset(tag)]))).data.committed).toBe(true);
    expect(await count('asset', B.id)).toBe(1);
    expect((await one("SELECT count(*)::int AS n FROM app.category WHERE company_id = $1 AND name = '노트북'", [B.id])).n).toBe(1);
  });

  it('동시에 올리면 하나만 처리하고 나머지는 기다리게 하지 않고 바로 거절한다', async () => {
    const tag = uniq('IA-');
    const model = uniq('Race');
    const file = () => xlsx([H.assets, asset(tag, { 3: model, 5: uniq('RaceDept') })]);
    const results = await Promise.all([upload(importAssets as Handler, 'admin', file()), upload(importAssets as Handler, 'admin', file()), upload(importAssets as Handler, 'admin', file())]);
    // 겹친 요청은 바로 거절(429)되고, 앞의 것이 끝난 뒤에 도착한 요청은 태그가 겹쳐 내용 오류(422)가 된다. 어느 쪽이든 한 건만 반영된다.
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((x) => x === 200).length).toBe(1);
    expect(statuses.every((x) => x === 200 || x === 429 || x === 422)).toBe(true);
    // 끝난 뒤에는 다시 받을 수 있다(겹치는 태그라 이번에는 내용 오류로 거부된다).
    expect((await upload(importAssets as Handler, 'admin', file())).status).toBe(422);
    expect((await one('SELECT count(*)::int AS n FROM app.item_model WHERE company_id = $1 AND name = $2', [A.id, model])).n).toBe(1);
  });
});

describe('주변기기 업로드', () => {
  it('수량이 더해지고 최초 입력(INITIAL) 이력이 남는다. 같은 (모델, 부서)가 여러 행이면 합쳐진다', async () => {
    const model = uniq('Mouse');
    const file = xlsx([H.peripherals, ['마우스', 'Logi', model, null, 10], ['마우스', 'logi', model.toUpperCase(), 'HR', 4], ['마우스', 'Logi', model, 'IT', '6']]);
    const done = await upload(importPeripherals as Handler, 'admin', file);
    expect(done.data).toMatchObject({ committed: true, created: { models: [`Logi ${model}`] } });
    const rows = (await (await owner()).query(
      `SELECT d.name, s.on_hand_qty, (SELECT string_agg(t.type || ':' || t.qty, ',' ORDER BY t.seq) FROM app.peripheral_txn t WHERE t.stock_id = s.id) AS txns
         FROM app.peripheral_stock s JOIN app.item_model m ON m.id = s.model_id JOIN app.department d ON d.id = s.department_id
        WHERE s.company_id = $1 AND m.name = $2 ORDER BY d.name`,
      [A.id, model],
    )).rows;
    expect(rows).toEqual([{ name: 'HR', on_hand_qty: 4, txns: 'INITIAL:4' }, { name: 'IT', on_hand_qty: 16, txns: 'INITIAL:10,INITIAL:6' }]);
  });

  it('수량이 0 이하이거나 정수가 아니면 거부하고, 자산용 모델로는 올릴 수 없다', async () => {
    const m = uniq('P');
    for (const q of [0, -1, 1.5, 'abc', 1_000_001]) {
      const r = await upload(importPeripherals as Handler, 'admin', xlsx([H.peripherals, ['마우스', 'Logi', m, null, q]]));
      expect(r.status, String(q)).toBe(422);
    }
    const r = await upload(importPeripherals as Handler, 'admin', xlsx([H.peripherals, ['노트북', 'Lenovo', 'X1', null, 1]]));
    expect(r.status).toBe(422);
    expect((await one('SELECT count(*)::int AS n FROM app.item_model WHERE company_id = $1 AND name = $2', [A.id, m])).n).toBe(0);
  });
});

describe('검토에서 드러난, 테스트가 없던 보장', () => {
  it('엑셀로 올린 재고도 한계 수량 판정을 일으킨다(판정은 업로드 끝에 한 번)', async () => {
    const { POST: thresholdCreate } = await import('@/app/api/thresholds/route');
    const o = await owner();
    const model = uniq('ThrMouse');
    await upload(importPeripherals as Handler, 'admin', xlsx([H.peripherals, ['마우스', 'Logi', model, null, 1]]));
    const modelId = (await one('SELECT id FROM app.item_model WHERE company_id = $1 AND name = $2', [A.id, model])).id;
    const created = await thresholdCreate(
      new Request('http://app.test/api/thresholds', { method: 'POST', headers: { host: 'app.test', origin: 'http://app.test', cookie: cookie.admin!, 'content-type': 'application/json' }, body: JSON.stringify({ modelId, minQty: 5 }) }),
    );
    const thresholdId = (await created.json()).thresholdId as string;
    expect((await one('SELECT state FROM app.stock_threshold WHERE id = $1', [thresholdId])).state).toBe('LOW');
    // 미리보기는 상태를 바꾸지 않는다.
    await upload(importPeripherals as Handler, 'admin', xlsx([H.peripherals, ['마우스', 'Logi', model, null, 3], ['마우스', 'Logi', model, null, 3]]), 'preview');
    expect((await one('SELECT state FROM app.stock_threshold WHERE id = $1', [thresholdId])).state).toBe('LOW');
    await upload(importPeripherals as Handler, 'admin', xlsx([H.peripherals, ['마우스', 'Logi', model, null, 3], ['마우스', 'Logi', model, null, 3]]));
    expect((await one('SELECT state FROM app.stock_threshold WHERE id = $1', [thresholdId])).state).toBe('OK');
    const types = (await o.query("SELECT type FROM app.notification WHERE payload ->> 'thresholdId' = $1 ORDER BY created_at, id", [thresholdId])).rows.map((r) => r.type);
    expect([...new Set(types)]).toEqual(['LOW_STOCK', 'STOCK_RECOVERED']);
  });

  it('시리얼 번호 중복 검사는 대소문자를 구분하지 않고, 서식만 있는 빈 행과 셀 안 줄바꿈이 있는 위치를 받는다', async () => {
    const sn = uniq('SNX');
    expect((await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(uniq('IA-'), { 4: sn })]))).data.committed).toBe(true);
    const dup = await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(uniq('IA-'), { 4: sn.toLowerCase() })]));
    expect(dup.status).toBe(422);
    const tag = uniq('IA-');
    expect((await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(tag, { 6: '본관 3층\n301호' })]))).data.committed).toBe(true);
    expect((await one('SELECT location FROM app.asset WHERE company_id = $1 AND asset_tag = $2', [A.id, tag])).location).toBe('본관 3층\n301호');
    // 값이 없는 행 5,000개가 뒤따라도 자료 행만 센다.
    const col = (i: number) => String.fromCharCode(65 + i);
    const header = `<row r="1">${H.persons.map((h, c) => `<c r="${col(c)}1" t="inlineStr"><is><t>${h}</t></is></c>`).join('')}</row>`;
    const data = `<row r="2"><c r="B2" t="inlineStr"><is><t>FormattedRows</t></is></c></row>`;
    const empty = Array.from({ length: 5000 }, (_, i) => `<row r="${i + 3}"><c r="A${i + 3}" s="1" /></row>`).join('');
    const file = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${header}${data}${empty}</sheetData></worksheet>`) });
    expect((await upload(importPersons as Handler, 'admin', file, 'preview')).data).toMatchObject({ totalRows: 1, errors: [] });
  });
});

describe('6단계 검토에서 드러난, 테스트가 없던 보장', () => {
  it('줄바꿈은 위치 칸에서만 받는다(이름·태그·모델 등은 거부). 위치도 다른 제어 문자는 거부한다', async () => {
    const cases: [Partial<Record<number, string>>, boolean][] = [
      [{ 6: '1층\n창고' }, true],
      [{ 6: '1층\u0007창고' }, false],
      [{ 3: 'X1\nPro' }, false], // 모델명
      [{ 2: 'Len\rovo' }, false], // 제조사
      [{ 4: 'SN\n1' }, false], // 시리얼
      [{ 10: '공급\n업체' }, false], // 공급업체
    ];
    for (const [over, ok] of cases) {
      const r = await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(uniq('IA-'), over)]), 'preview');
      expect(r.data.errors.length === 0, JSON.stringify(over)).toBe(ok);
    }
    const person = await upload(importPersons as Handler, 'admin', xlsx([H.persons, [null, '홍\n길동', null, null]]), 'preview');
    expect(person.data.errors.length).toBe(1);
  });

  it('보유자 사번은 대소문자를 구분하지 않고 찾는다', async () => {
    const no = uniq('Hold');
    await upload(importPersons as Handler, 'admin', xlsx([H.persons, [no, '보유자2', null, null]]));
    const tag = uniq('IA-');
    const r = await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(tag, { 7: no.toUpperCase() })]));
    expect(r.data.committed).toBe(true);
    expect((await one('SELECT state FROM app.asset WHERE company_id = $1 AND asset_tag = $2', [A.id, tag])).state).toBe('IN_USE');
  });

  it('같은 기업의 업로드를 받는 중이면 그 기업의 다른 업로드는 바로 거절하고, 끝나면(끊겨도) 다시 받는다', async () => {
    let release!: () => void;
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x50, 0x4b]));
        release = () => controller.error(new Error('client aborted'));
      },
    });
    const pending = (importAssets as Handler)(
      new Request('http://app.test/api/import/x?mode=preview', {
        method: 'POST', headers: { host: 'app.test', origin: 'http://app.test', cookie: cookie.admin! }, body: slow, duplex: 'half',
      } as RequestInit),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect((await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(uniq('IA-'))]), 'preview')).status).toBe(429);
    // 다른 기업은 영향이 없다.
    expect((await upload(importAssets as Handler, 'badmin', xlsx([H.assets, asset(uniq('IA-'))]), 'preview')).status).toBe(200);
    release();
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    expect((await upload(importAssets as Handler, 'admin', xlsx([H.assets, asset(uniq('IA-'))]), 'preview')).status).toBe(200);
  });
});

describe('자산 업로드: 상태 열과 사용자 지정 필드 열', () => {
  const state = (tag: string) => one('SELECT a.id, a.state, a.substate, a.holder_person_id IS NOT NULL AS held, a.custom FROM app.asset a WHERE a.company_id = $1 AND a.asset_tag = $2', [A.id, tag]);
  const types = async (assetId: string) => (await (await owner()).query('SELECT type FROM app.asset_txn WHERE asset_id = $1 ORDER BY created_at, seq', [assetId])).rows.map((r) => r.type);

  it('상태를 적으면 등록 뒤 그 처리를 차례로 적용하고 이력이 남는다(상태를 직접 써넣지 않는다)', async () => {
    await upload(importPersons as Handler, 'admin', xlsx([H.persons, ['ST-1', '상태보유자', null, null]]));
    const t = { stock: uniq('ST-'), disposed: uniq('ST-'), sold: uniq('ST-'), repair: uniq('ST-'), missing: uniq('ST-'), defective: uniq('ST-') };
    const done = await upload(importAssets as Handler, 'admin', xlsx([
      H.assets,
      asset(t.stock, { 12: '재고' }),
      asset(t.disposed, { 12: 'Disposed' }), // 영문·대소문자도 받는다
      asset(t.sold, { 12: '매각' }),
      asset(t.repair, { 7: 'ST-1', 12: '수리 중' }), // 보유자를 유지한 채 수리 입고
      asset(t.missing, { 12: '분실' }),
      asset(t.defective, { 12: '불량' }),
    ]));
    expect(done.data).toMatchObject({ committed: true, totalRows: 6 });
    expect(await state(t.stock)).toMatchObject({ state: 'IN_STOCK', substate: 'AVAILABLE' });
    const disposed = await state(t.disposed);
    expect(disposed).toMatchObject({ state: 'RETIRED', substate: 'DISPOSED', held: false });
    expect(await types(disposed.id)).toEqual(['REGISTER', 'RETIRE', 'DISPOSE']);
    expect(await state(t.sold)).toMatchObject({ state: 'RETIRED', substate: 'SOLD' });
    const repair = await state(t.repair);
    expect(repair).toMatchObject({ state: 'MAINTENANCE', held: true });
    expect(await types(repair.id)).toEqual(['REGISTER', 'ASSIGN', 'REPAIR_IN']);
    expect(await state(t.missing)).toMatchObject({ state: 'MISSING' });
    expect(await state(t.defective)).toMatchObject({ state: 'IN_STOCK', substate: 'DEFECTIVE' });
  });

  it('알 수 없는 상태, 보유자와 맞지 않는 상태는 행 오류이고 아무것도 반영하지 않는다', async () => {
    const before = await count('asset', A.id);
    const res = await upload(importAssets as Handler, 'admin', xlsx([
      H.assets,
      asset(uniq('ST-'), { 12: '어딘가' }),
      asset(uniq('ST-'), { 7: 'ST-1', 12: '폐기' }),
      asset(uniq('ST-'), { 12: '사용중' }),
      asset(uniq('ST-')),
    ]));
    expect(res.status).toBe(422);
    expect(res.data.errors.map((e: { row: number }) => e.row)).toEqual([2, 3, 4]);
    expect(res.data.errors[0].message).toContain('알 수 없는 값');
    expect(res.data.errors[1].message).toContain('보유자사번과 함께 쓸 수 없습니다');
    expect(res.data.errors[2].message).toContain('보유자사번이 있어야');
    expect(await count('asset', A.id)).toBe(before);
  });

  it('상태 열은 그 처리를 할 권한이 있어야 쓸 수 있다', async () => {
    const before = await count('asset', A.id);
    const retire = await upload(importAssets as Handler, 'importer', xlsx([H.assets, asset(uniq('ST-'), { 12: '폐기' })]));
    expect(retire.status).toBe(422);
    expect(retire.data.errors[0].message).toContain('권한이 없습니다');
    const defective = await upload(importAssets as Handler, 'importer', xlsx([H.assets, asset(uniq('ST-'), { 12: '불량' })]));
    expect(defective.data.errors[0].message).toContain('권한이 없습니다');
    expect(await count('asset', A.id)).toBe(before);
    // 재고(처리 없음)는 권한 없이도 적을 수 있다.
    expect((await upload(importAssets as Handler, 'importer', xlsx([H.assets, asset(uniq('ST-'), { 12: '재고' })]))).data.committed).toBe(true);
  });

  it('사용자 지정 필드는 표시 이름이나 키를 머리글로 한 열로 올린다. 제한 필드는 권한이 있어야 한다', async () => {
    const o = await owner();
    for (const [key, label, type, restricted] of [['mac', 'MAC 주소', 'text', false], ['cap_no', '회계번호', 'number', false], ['checked', '실사', 'boolean', false], ['svc_start', '서비스시작', 'date', false], ['secret_note', '비밀메모', 'text', true]] as const) {
      await o.query('INSERT INTO app.custom_field_def (company_id, key, label, data_type, is_restricted) VALUES ($1, $2, $3, $4, $5)', [A.id, key, label, type, restricted]);
    }
    // 다른 기업의 같은 이름 필드는 이 기업의 열이 되지 않는다.
    await o.query("INSERT INTO app.custom_field_def (company_id, key, label, data_type) VALUES ($1, 'only_b', 'B전용', 'text')", [B.id]);
    const tag = uniq('CF-');
    const head = [...H.assets, 'MAC 주소', 'cap_no', '실사', '서비스시작'];
    const done = await upload(importAssets as Handler, 'admin', xlsx([head, [...asset(tag), null, 'AA:BB:CC:00:11:22', 127001, 'Y', '2022.2.4'], [...asset(uniq('CF-')), null, null, null, null, null]]));
    expect(done.data).toMatchObject({ committed: true, totalRows: 2 });
    expect((await state(tag)).custom).toEqual({ mac: 'AA:BB:CC:00:11:22', cap_no: 127001, checked: true, svc_start: '2022-02-04' });

    const unknown = await upload(importAssets as Handler, 'admin', xlsx([[...H.assets, 'B전용'], [...asset(uniq('CF-')), null, 'x']]));
    expect(unknown.data.errors[0].message).toContain('알 수 없는 열');
    const badValue = await upload(importAssets as Handler, 'admin', xlsx([[...H.assets, '실사', 'cap_no'], [...asset(uniq('CF-')), null, '글쎄', 'abc']]));
    expect(badValue.data.errors.map((e: { message: string }) => e.message).join(' ')).toMatch(/예\/아니오.*숫자가 아닙니다|숫자가 아닙니다.*예\/아니오/);
    const restricted = await upload(importAssets as Handler, 'importer', xlsx([[...H.assets, '비밀메모'], [...asset(uniq('CF-')), null, '몰래']]));
    expect(restricted.status).toBe(422);
    expect(restricted.data.errors[0].message).toContain('제한된 사용자 지정 필드');
    // 그 열을 비워 두면 권한 없이도 올릴 수 있다.
    expect((await upload(importAssets as Handler, 'importer', xlsx([[...H.assets, '비밀메모'], [...asset(uniq('CF-')), null, null]]))).data.committed).toBe(true);
  });
});
