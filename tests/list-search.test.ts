// 목록 화면의 검색·열 필터·정렬·상태별 요약(자산, 주변기기 재고).
// 지키려는 것: 허용 목록 밖의 이름은 400, 읽을 수 없는 필드로 거르거나 찾거나 정렬하면 403(값을 추정하는 통로가 되지 않게),
// 부서 범위·기업 격리는 새 조건과 요약에도 그대로, LIKE 문자는 글자 그대로, 쪽 넘김은 안정적.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/context';
import type { DataAccess } from '@/lib/authz/scope';
import type { Actor } from '@/lib/http/route';
import { listAssets } from '@/lib/assets/assets';
import { GET as assetsList } from '@/app/api/assets/route';
import { GET as stockList } from '@/app/api/peripherals/route';
import { ASSET_SORT_KEYS } from '@/lib/assets/assets';
import { STOCK_SORT_KEYS } from '@/lib/peripherals/peripherals';
import { SORT_KEYS as SCREEN_ASSET_SORT_KEYS } from '@/app/(app)/assets/types';
import { STOCK_SORT_KEYS as SCREEN_STOCK_SORT_KEYS } from '@/app/(app)/peripherals/types';
import { closePool } from '@/lib/db/pool';
import { APP_ROLE, call, closeOwner, makeCompany, makeUser, owner, sessionFor, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};

type Row = { id: string; asset_tag: string };
const list = (as: string, qs: string) => call(assetsList, { cookie: cookie[as], path: `/api/assets?${qs}` });
const tags = async (as: string, qs: string): Promise<string[]> => {
  const r = await list(as, qs.includes('pageSize') ? qs : `${qs}&pageSize=200`);
  expect(r.status, `${as} ${qs}: ${JSON.stringify(r.data)}`).toBe(200);
  return (r.data.items as Row[]).map((a) => a.asset_tag).sort();
};
const enc = encodeURIComponent;

interface AssetSeed {
  tag: string;
  model: string;
  dept: string;
  state: string;
  substate?: string | null;
  holder?: string | null;
  serial?: string | null;
  location?: string | null;
  supplier?: string | null;
  price?: number | null;
  pdate?: string | null;
  wend?: string | null;
  due?: string | null;
  custom?: Record<string, unknown>;
}

async function insertAsset(companyId: string, a: AssetSeed): Promise<string> {
  const o = await owner();
  const r = await o.query<{ id: string }>(
    `INSERT INTO app.asset (company_id, model_id, asset_tag, serial_number, state, substate, department_id, location, holder_person_id,
                            supplier, purchase_price, purchase_date, warranty_end, custom, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [companyId, a.model, a.tag, a.serial ?? null, a.state, a.substate ?? null, a.dept, a.location ?? null, a.holder ?? null,
      a.supplier ?? null, a.price ?? null, a.pdate ?? null, a.wend ?? null, JSON.stringify(a.custom ?? {}), a.due ?? null],
  );
  return r.rows[0]!.id;
}

async function userWithRole(c: TestCompany, loginId: string, roleName: string, deptIds: string[] = []): Promise<void> {
  const o = await owner();
  const userId = await makeUser(c.id, loginId, 'COMPANY_USER');
  const role = (await o.query('SELECT id FROM app.role WHERE company_id = $1 AND name = $2', [c.id, roleName])).rows[0].id;
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [userId, role, c.id]);
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [userId, d, c.id]);
  cookie[loginId] = await sessionFor(c.code, loginId);
}

async function seed(c: TestCompany, p: string): Promise<void> {
  const o = await owner();
  const q = async (sql: string, params: unknown[]) => (await o.query(sql, params)).rows[0].id as string;
  id[`${p}it`] = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [c.id])).rows[0].id;
  id[`${p}hr`] = await q("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [c.id]);
  const laptop = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [c.id]);
  const monitor = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Monitor') RETURNING id", [c.id]);
  const mouse = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Mouse') RETURNING id", [c.id]);
  const cable = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Cable') RETURNING id", [c.id]);
  id[`${p}x1`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Lenovo', 'X1') RETURNING id", [c.id, laptop]);
  id[`${p}u27`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Dell', 'U27') RETURNING id", [c.id, monitor]);
  id[`${p}m1`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'Logi', 'M1') RETURNING id", [c.id, mouse]);
  id[`${p}hdmi`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'Belkin', 'HDMI_2%') RETURNING id", [c.id, cable]);
  id[`${p}kim`] = await q("INSERT INTO app.person (company_id, employee_no, name) VALUES ($1, 'E100', 'Kim') RETURNING id", [c.id]);
  id[`${p}park`] = await q("INSERT INTO app.person (company_id, employee_no, name) VALUES ($1, 'E200', 'Park') RETURNING id", [c.id]);
  await o.query(
    `INSERT INTO app.custom_field_def (company_id, key, label, data_type, is_restricted, is_active) VALUES
       ($1, 'mac', 'MAC', 'text', false, true), ($1, 'cost_center', 'Cost center', 'text', true, true),
       ($1, 'seats', 'Seats', 'number', false, true), ($1, 'legacy', 'Legacy', 'text', false, false)`,
    [c.id],
  );
  for (const [model, dept, onHand, onLoan] of [[id[`${p}m1`], id[`${p}it`], 5, 1], [id[`${p}m1`], id[`${p}hr`], 0, 2], [id[`${p}hdmi`], id[`${p}it`], 12, 0]] as const) {
    await o.query('INSERT INTO app.peripheral_stock (company_id, model_id, department_id, on_hand_qty, on_loan_qty) VALUES ($1, $2, $3, $4, $5)', [c.id, model, dept, onHand, onLoan]);
  }
}

beforeAll(async () => {
  A = await makeCompany('LSA');
  B = await makeCompany('LSB');
  await seed(A, '');
  await seed(B, 'b');
  await (await owner()).query("INSERT INTO app.custom_field_def (company_id, key, label, data_type) VALUES ($1, 'bonly', 'B only', 'text')", [B.id]);
  const assets: AssetSeed[] = [
    { tag: 'NB-001', model: id.x1!, dept: id.it!, state: 'IN_STOCK', substate: 'AVAILABLE', serial: 'SN-AAA', location: 'Seoul 3F', supplier: 'AcmeSupply', price: 1000, pdate: '2024-01-10', wend: '2027-01-10', custom: { mac: 'aa:01', cost_center: 'CC-HIDDEN-1', seats: 1 } },
    { tag: 'NB-002', model: id.x1!, dept: id.it!, state: 'IN_USE', holder: id.kim!, serial: 'SN-BBB', location: 'Busan', supplier: 'Zeta', price: 2000, pdate: '2023-05-02', due: '2026-01-31', custom: { mac: 'bb:02', legacy: 'LEG-ONLY' } },
    { tag: 'NB-003', model: id.x1!, dept: id.hr!, state: 'IN_STOCK', substate: 'DEFECTIVE', serial: 'SN_100%', location: 'Seoul 5F', custom: { mac: 'cc:03' } },
    { tag: 'MN-001', model: id.u27!, dept: id.hr!, state: 'IN_USE', holder: id.park!, serial: 'SN-CCC', location: 'Seoul 3F', wend: '2026-12-31', due: '2027-03-01' },
    { tag: 'MN-002', model: id.u27!, dept: id.it!, state: 'MAINTENANCE' },
    { tag: 'MN-003', model: id.u27!, dept: id.it!, state: 'RETIRED', substate: 'PENDING_DISPOSAL', location: 'Warehouse' },
    { tag: 'NB-VOID', model: id.x1!, dept: id.it!, state: 'VOID', location: 'Seoul 3F' },
  ];
  for (const a of assets) id[a.tag] = await insertAsset(A.id, a);
  // B 에도 같은 값의 자산이 있다(A 의 조회에 섞이면 안 된다).
  await insertAsset(B.id, { tag: 'NB-001', model: id.bx1!, dept: id.bit!, state: 'IN_STOCK', substate: 'AVAILABLE', location: 'Seoul 3F', serial: 'SN-AAA', custom: { mac: 'aa:01', bonly: 'B-SECRET' } });
  await insertAsset(B.id, { tag: 'NB-B2', model: id.bx1!, dept: id.bhr!, state: 'IN_USE', holder: id.bkim!, location: 'Seoul 3F' });

  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  await userWithRole(A, 'viewer', 'Viewer');
  await userWithRole(A, 'oper', 'Stock Operator'); // 제한 필드 읽기 권한 없음
  await userWithRole(A, 'manager', 'Stock Manager'); // 제한 필드 포함
  await userWithRole(A, 'hroper', 'Stock Operator', [id.hr!]); // 부서 범위: HR
  await userWithRole(A, 'hrmanager', 'Stock Manager', [id.hr!]);
  await makeUser(A.id, 'norole', 'COMPANY_USER'); // 역할 없음
  cookie.norole = await sessionFor(A.code, 'norole');
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('화면과 서버의 정렬 기준 목록', () => {
  it('같다(화면은 서버 모듈을 import 할 수 없어 따로 적어 둔다)', () => {
    expect([...SCREEN_ASSET_SORT_KEYS]).toEqual([...ASSET_SORT_KEYS]);
    expect([...SCREEN_STOCK_SORT_KEYS]).toEqual([...STOCK_SORT_KEYS]);
  });
});

describe('자산: 필드를 골라 검색(qField)', () => {
  it('각 필드는 그 필드에서만 찾는다', async () => {
    const cases: [string, string, string[]][] = [
      ['asset_tag', 'NB-00', ['NB-001', 'NB-002', 'NB-003']],
      ['asset_tag', 'seoul', []],
      ['category', 'monit', ['MN-001', 'MN-002', 'MN-003']],
      ['manufacturer', 'DELL', ['MN-001', 'MN-002', 'MN-003']],
      ['manufacturer', 'X1', []],
      ['model', 'x1', ['NB-001', 'NB-002', 'NB-003']],
      ['serial', 'SN-', ['MN-001', 'NB-001', 'NB-002']],
      ['holder', 'kim', ['NB-002']],
      ['holder', 'E200', ['MN-001']],
      ['employee_no', 'E1', ['NB-002']],
      ['department', 'HR', ['MN-001', 'NB-003']],
      ['location', 'seoul', ['MN-001', 'NB-001', 'NB-003']],
      ['location', 'Busan', ['NB-002']],
      ['purchase_date', '2024-01', ['NB-001']],
      ['warranty_end', '2026-12', ['MN-001']],
      ['cf.mac', 'BB:', ['NB-002']],
      ['cf.seats', '1', ['NB-001']],
    ];
    for (const [field, q, expected] of cases) {
      expect(await tags('oper', `qField=${enc(field)}&q=${enc(q)}`), `${field}=${q}`).toEqual(expected.sort());
    }
    // 권한이 있으면 제한 필드에서도 찾는다.
    expect(await tags('manager', 'qField=supplier&q=acme')).toEqual(['NB-001']);
    expect(await tags('manager', 'qField=purchase_price&q=2000')).toEqual(['NB-002']);
    expect(await tags('manager', `qField=cf.cost_center&q=${enc('CC-HIDDEN')}`)).toEqual(['NB-001']);
  });

  it('qField=all(기본)은 기존 대상에 카테고리·부서·사번을 더해 찾는다', async () => {
    expect(await tags('oper', 'q=monitor')).toEqual(['MN-001', 'MN-002', 'MN-003']);
    expect(await tags('oper', 'qField=all&q=monitor')).toEqual(['MN-001', 'MN-002', 'MN-003']);
    expect(await tags('oper', 'q=E100')).toEqual(['NB-002']);
    expect(await tags('oper', 'q=HR')).toEqual(['MN-001', 'NB-003']);
    expect(await tags('oper', 'q=warehouse')).toEqual(['MN-003']);
  });

  it('qField=all 은 숨겨진 값(제한 필드·제한된/비활성 사용자 지정 필드)으로는 맞지 않는다 — 권한이 있어도', async () => {
    for (const who of ['oper', 'manager', 'admin']) {
      for (const hidden of ['AcmeSupply', 'Zeta', 'CC-HIDDEN', '1000', 'LEG-ONLY']) {
        expect(await tags(who, `q=${enc(hidden)}`), `${who} q=${hidden}`).toEqual([]);
        expect(await tags(who, `qField=all&q=${enc(hidden)}`), `${who} qField=all q=${hidden}`).toEqual([]);
      }
    }
  });
});

describe('자산: 열 필터', () => {
  it('여러 열 조건은 AND 로 묶이고, 검색(q)과도 AND 다', async () => {
    expect(await tags('oper', 'f_location=Seoul&f_category=Laptop')).toEqual(['NB-001', 'NB-003']);
    expect(await tags('oper', 'f_location=Seoul&f_category=Laptop&f_department=HR')).toEqual(['NB-003']);
    expect(await tags('oper', 'f_location=Seoul&f_category=Laptop&q=SN-AAA')).toEqual(['NB-001']);
    expect(await tags('oper', 'f_location=Seoul&qField=location&q=3F')).toEqual(['MN-001', 'NB-001']);
    expect(await tags('oper', 'f_cf.mac=aa&f_model=X1')).toEqual(['NB-001']);
    expect(await tags('oper', 'f_cf.mac=aa&f_model=U27')).toEqual([]);
    // 빈 값·공백은 조건이 없는 것과 같다.
    expect(await tags('oper', 'f_location=&f_model=%20%20')).toEqual(['MN-001', 'MN-002', 'MN-003', 'NB-001', 'NB-002', 'NB-003']);
    // 기존 조건(state, includeVoid)과도 함께 쓴다.
    expect(await tags('oper', 'f_location=Seoul&state=IN_USE')).toEqual(['MN-001']);
    expect(await tags('oper', 'f_location=Seoul&includeVoid=true')).toEqual(['MN-001', 'NB-001', 'NB-003', 'NB-VOID']);
  });

  it('검색어의 % 와 _ 는 글자 그대로다', async () => {
    expect(await tags('oper', `f_serial=${enc('%')}`)).toEqual(['NB-003']);
    expect(await tags('oper', `f_serial=${enc('_')}`)).toEqual(['NB-003']);
    expect(await tags('oper', `f_serial=${enc('N_1')}`)).toEqual(['NB-003']);
    expect(await tags('oper', `f_asset_tag=${enc('NB_0')}`)).toEqual([]);
    expect(await tags('oper', `qField=serial&q=${enc('%')}`)).toEqual(['NB-003']);
    expect(await tags('oper', `q=${enc('S_-')}`)).toEqual([]);
    expect(await tags('oper', `f_location=${enc('\\')}`)).toEqual([]);
  });
});

describe('권한', () => {
  it('목록 조회 권한이 없으면 새 조건을 붙여도 403 이고 아무것도 돌려주지 않는다', async () => {
    for (const qs of ['', 'f_asset_tag=NB', 'qField=serial&q=SN', 'f_cf.mac=aa', 'sort=location']) {
      const r = await list('norole', qs);
      expect(r.status, qs).toBe(403);
      expect(JSON.stringify(r.data)).not.toMatch(/NB-0|summary/);
      const s = await slist('norole', qs.replace('asset_tag', 'model').replace('serial', 'model').replace('f_cf.mac', 'f_model').replace('location', 'on_hand'));
      expect(s.status, qs).toBe(403);
    }
  });
});

describe('자산: 잘못된 요청은 400', () => {
  it('모르는 qField·열·정렬, 형식이 틀린 값', async () => {
    const bad = [
      'qField=nope&q=x', 'qField=nope', 'qField=ALL&q=x', 'qField=cf.&q=x', 'f_nope=x', 'f_=x', 'f_ASSET_TAG=x', 'f_cf.=x',
      'sort=nope', 'sort=cf.mac', 'order=up',
      `f_model=${enc('a\u0001b')}`, `f_model=${enc('a\nb')}`, `f_model=${'x'.repeat(101)}`, `q=${'x'.repeat(101)}`,
      'f_model=a&f_model=b',
      'pageSize=0', 'pageSize=201', 'pageSize=abc',
    ];
    for (const qs of bad) expect((await list('admin', qs)).status, qs).toBe(400);
    expect((await list('admin', `f_model=${'x'.repeat(100)}`)).status).toBe(200);
  });

  it('정의되지 않은·비활성·다른 기업의 사용자 지정 필드, SQL 이 든 키는 400 이고 아무것도 돌려주지 않는다', async () => {
    const keys = ['cf.nope', 'cf.legacy', 'cf.bonly', "cf.x') OR 1=1 --", 'cf.mac OR 1=1', 'cf.MAC', "cf.mac'--", 'cf.mac;'];
    for (const k of keys) {
      for (const qs of [`f_${enc(k)}=a`, `qField=${enc(k)}&q=a`, `qField=${enc(k)}`]) {
        const r = await list('admin', qs);
        expect(r.status, qs).toBe(400);
        expect(r.data.items, qs).toBeUndefined();
        expect(JSON.stringify(r.data), qs).not.toMatch(/NB-0|MN-0/);
      }
    }
  });
});

describe('자산: 읽을 수 없는 필드는 거르기·찾기·정렬 모두 403', () => {
  it('공급업체·구매가·제한된 사용자 지정 필드', async () => {
    const denied = [
      'f_supplier=a', 'qField=supplier&q=Acme', 'qField=supplier', 'sort=supplier', 'sort=supplier&order=desc',
      'f_purchase_price=1', 'qField=purchase_price&q=1000', 'sort=purchase_price',
      'f_cf.cost_center=CC', 'qField=cf.cost_center&q=CC', 'qField=cf.cost_center',
      // 빈 값이어도(조건이 없는 것과 같아도) 이름만으로 거부한다.
      'f_supplier=', 'f_cf.cost_center=',
    ];
    for (const who of ['oper', 'viewer', 'hroper']) {
      for (const qs of denied) {
        const r = await list(who, qs);
        expect(r.status, `${who} ${qs}`).toBe(403);
        expect(JSON.stringify(r.data), `${who} ${qs}`).not.toMatch(/NB-0|MN-0|Acme|CC-HIDDEN/);
      }
    }
    for (const qs of denied) expect((await list('manager', qs)).status, `manager ${qs}`).toBe(200);
  });

  it('응답의 필드 목록에도 읽을 수 없는 필드는 없다', async () => {
    const limited = (await list('oper', '')).data.fields;
    expect(limited).toEqual({ custom: [{ key: 'mac', label: 'MAC', data_type: 'text' }, { key: 'seats', label: 'Seats', data_type: 'number' }] });
    const full = (await list('manager', '')).data.fields;
    expect(full.supplier).toBe(true);
    expect(full.purchasePrice).toBe(true);
    expect(full.custom.map((c: { key: string }) => c.key).sort()).toEqual(['cost_center', 'mac', 'seats']);
  });
});

describe('자산: 부서 범위와 기업 격리', () => {
  it('범위가 제한된 사용자는 어떤 새 조건으로도 범위 밖 자산을 보거나 세지 못한다', async () => {
    const scoped = [
      'f_location=Seoul', 'qField=location&q=Seoul', 'qField=department&q=IT', 'f_department=IT', 'q=IT', 'f_asset_tag=NB',
      'f_cf.mac=a', 'qField=holder&q=Kim', 'f_category=Laptop', 'sort=location&order=desc',
    ];
    const inScope = new Set(['NB-003', 'MN-001']);
    for (const qs of scoped) {
      const r = await list('hroper', qs);
      expect(r.status, qs).toBe(200);
      const seen = (r.data.items as Row[]).map((a) => a.asset_tag);
      for (const t of seen) expect(inScope.has(t), `${qs}: ${t}`).toBe(true);
      expect(r.data.total, qs).toBe(seen.length);
      expect(r.data.summary.total, qs).toBeLessThanOrEqual(2);
    }
    expect(await tags('hroper', 'f_department=IT')).toEqual([]);
    expect((await list('hroper', 'f_department=IT')).data.summary).toEqual({ total: 0, byState: {}, inStock: {} });
    expect((await list('hroper', '')).data.summary).toEqual({ total: 2, byState: { IN_STOCK: 1, IN_USE: 1 }, inStock: { DEFECTIVE: 1 } });
    // 범위 안에서 제한 필드 권한이 있으면 제한 필드로 찾을 수 있지만, 범위 밖 값은 찾지 못한다.
    expect(await tags('hrmanager', 'qField=supplier&q=Acme')).toEqual([]);
  });

  it('다른 기업의 자산은 나오지 않고, 다른 기업의 사용자 지정 필드는 쓸 수 없다', async () => {
    expect(await tags('admin', 'f_asset_tag=NB-001')).toEqual(['NB-001']);
    const ids = ((await list('admin', 'f_location=Seoul&includeVoid=true&pageSize=200')).data.items as Row[]).map((a) => a.id);
    expect(ids.sort()).toEqual([id['NB-001'], id['NB-003'], id['MN-001'], id['NB-VOID']].sort());
    expect((await list('admin', 'f_cf.bonly=B')).status).toBe(400);
    expect((await list('badmin', 'f_cf.bonly=B-SECRET')).status).toBe(200);
    expect(await tags('badmin', 'f_cf.bonly=B-SECRET')).toEqual(['NB-001']);
    expect(await tags('badmin', 'f_location=Seoul')).toEqual(['NB-001', 'NB-B2']);
    expect((await list('badmin', 'f_location=Seoul')).data.summary.total).toBe(2);
    // B 에는 cost_center 가 있지만 A 의 값으로 맞지 않는다.
    expect(await tags('badmin', 'qField=cf.cost_center&q=CC-HIDDEN')).toEqual([]);
    expect(await tags('badmin', 'qField=holder&q=Park')).toEqual([]);
  });
});

describe('자산: 상태별 요약', () => {
  it('상태 조건은 무시하고 나머지 조건은 따르며, 상태별 목록 건수와 같다', async () => {
    for (const [who, qs] of [['admin', ''], ['admin', 'includeVoid=true'], ['admin', 'f_location=Seoul'], ['oper', 'f_category=Laptop'], ['hroper', ''], ['manager', 'qField=supplier&q=a']] as const) {
      const base = await list(who, qs);
      const s = base.data.summary;
      expect(s.total, `${who} ${qs}`).toBe(base.data.total);
      const sum = Object.values(s.byState as Record<string, number>).reduce((x, y) => x + y, 0);
      expect(sum).toBe(s.total);
      for (const [state, n] of Object.entries(s.byState as Record<string, number>)) {
        const r = await list(who, `${qs}&state=${state}`);
        expect(r.data.total, `${who} ${qs} state=${state}`).toBe(n);
        // 상태로 걸러도 요약은 그대로다(다른 상태 칩의 숫자가 사라지지 않게).
        expect(r.data.summary, `${who} ${qs} state=${state}`).toEqual(s);
      }
      for (const [sub, n] of Object.entries(s.inStock as Record<string, number>)) {
        expect((await list(who, `${qs}&state=IN_STOCK&substate=${sub}`)).data.total).toBe(n);
      }
    }
    expect((await list('admin', '')).data.summary).toEqual({
      total: 6, byState: { IN_STOCK: 2, IN_USE: 2, MAINTENANCE: 1, RETIRED: 1 }, inStock: { AVAILABLE: 1, DEFECTIVE: 1 },
    });
    expect((await list('admin', 'includeVoid=true')).data.summary.byState.VOID).toBe(1);
  });
});

describe('자산: 정렬과 쪽 넘김', () => {
  it('모든 정렬 기준이 양방향으로 되고, 쪽을 나눠 받아도 한 번에 받은 순서와 같다', async () => {
    for (const sort of ASSET_SORT_KEYS) {
      const seenOrders: string[] = [];
      for (const order of ['asc', 'desc']) {
        const full = await list('manager', `sort=${sort}&order=${order}&pageSize=200&includeVoid=true`);
        expect(full.status, `${sort} ${order}`).toBe(200);
        const all = (full.data.items as Row[]).map((a) => a.asset_tag);
        expect(all.length).toBe(7);
        const paged: string[] = [];
        for (let page = 1; page <= 4; page += 1) {
          const r = await list('manager', `sort=${sort}&order=${order}&pageSize=2&page=${page}&includeVoid=true`);
          paged.push(...(r.data.items as Row[]).map((a) => a.asset_tag));
        }
        expect(paged, `${sort} ${order}`).toEqual(all);
        seenOrders.push(all.join(','));
      }
      expect(seenOrders[0], `${sort}: asc 와 desc 가 같다`).not.toBe(seenOrders[1]);
    }
  });

  it('같은 값끼리는 자산 태그 순이다', async () => {
    const byCat = ((await list('admin', 'sort=category')).data.items as Row[]).map((a) => a.asset_tag);
    expect(byCat).toEqual(['NB-001', 'NB-002', 'NB-003', 'MN-001', 'MN-002', 'MN-003']);
    const byCatDesc = ((await list('admin', 'sort=category&order=desc')).data.items as Row[]).map((a) => a.asset_tag);
    expect(byCatDesc).toEqual(['MN-001', 'MN-002', 'MN-003', 'NB-001', 'NB-002', 'NB-003']);
    const byLoc = ((await list('admin', 'sort=location')).data.items as Row[]).map((a) => a.asset_tag);
    expect(byLoc).toEqual(['NB-002', 'MN-001', 'NB-001', 'NB-003', 'MN-003', 'MN-002']);
  });

  it('쪽 크기는 1~200, 기본 50', async () => {
    for (const n of [20, 50, 100, 200]) expect((await list('admin', `pageSize=${n}`)).data.pageSize).toBe(n);
    expect((await list('admin', '')).data.pageSize).toBe(50);
    expect((await list('admin', 'pageSize=2')).data.items).toHaveLength(2);
  });
});

// ─────────────────────────── 주변기기 ───────────────────────────

type Stock = { id: string; category_name: string; manufacturer: string; model_name: string; department_name: string; on_hand_qty: number; on_loan_qty: number };
const slist = (as: string, qs: string) => call(stockList, { cookie: cookie[as], path: `/api/peripherals?${qs}` });
const keys = async (as: string, qs: string): Promise<string[]> => {
  const r = await slist(as, qs);
  expect(r.status, `${as} ${qs}: ${JSON.stringify(r.data)}`).toBe(200);
  return (r.data.items as Stock[]).map((s) => `${s.model_name}@${s.department_name}`).sort();
};

describe('주변기기: 검색·열 필터·정렬', () => {
  it('필드를 골라 찾고, 열 조건은 AND, LIKE 문자는 글자 그대로', async () => {
    expect(await keys('oper', 'qField=category&q=mouse')).toEqual(['M1@HR', 'M1@IT']);
    expect(await keys('oper', 'qField=manufacturer&q=belk')).toEqual(['HDMI_2%@IT']);
    expect(await keys('oper', 'qField=manufacturer&q=mouse')).toEqual([]);
    expect(await keys('oper', 'qField=model&q=m1')).toEqual(['M1@HR', 'M1@IT']);
    expect(await keys('oper', 'qField=department&q=hr')).toEqual(['M1@HR']);
    expect(await keys('oper', 'q=hr')).toEqual(['M1@HR']); // 전체 필드에 부서도 들어간다
    expect(await keys('oper', 'q=cable')).toEqual(['HDMI_2%@IT']);
    expect(await keys('oper', 'f_category=mouse&f_department=IT')).toEqual(['M1@IT']);
    expect(await keys('oper', 'f_category=mouse&qField=department&q=HR')).toEqual(['M1@HR']);
    expect(await keys('oper', `f_model=${enc('_')}`)).toEqual(['HDMI_2%@IT']);
    expect(await keys('oper', `f_model=${enc('%')}`)).toEqual(['HDMI_2%@IT']);
    expect(await keys('oper', `q=${enc('M_')}`)).toEqual([]);
  });

  it('정렬 기준마다 양방향, 쪽 넘김이 안정적이다. 기본 순서는 예전과 같다(카테고리·제조사·모델·부서)', async () => {
    expect((((await slist('admin', '')).data.items) as Stock[]).map((s) => `${s.model_name}@${s.department_name}`)).toEqual(['HDMI_2%@IT', 'M1@HR', 'M1@IT']);
    for (const sort of STOCK_SORT_KEYS) {
      for (const order of ['asc', 'desc']) {
        const all = ((await slist('admin', `sort=${sort}&order=${order}`)).data.items as Stock[]).map((s) => s.id);
        const paged: string[] = [];
        for (let page = 1; page <= 3; page += 1) paged.push(...((await slist('admin', `sort=${sort}&order=${order}&pageSize=1&page=${page}`)).data.items as Stock[]).map((s) => s.id));
        expect(paged, `${sort} ${order}`).toEqual(all);
        expect(all).toHaveLength(3);
      }
    }
    const onHand = ((await slist('admin', 'sort=on_hand&order=desc')).data.items as Stock[]).map((s) => s.on_hand_qty);
    expect(onHand).toEqual([12, 5, 0]);
    const onLoan = ((await slist('admin', 'sort=on_loan')).data.items as Stock[]).map((s) => s.on_loan_qty);
    expect(onLoan).toEqual([0, 1, 2]);
  });

  it('잘못된 이름·값은 400', async () => {
    for (const qs of ['qField=nope&q=a', 'qField=supplier&q=a', 'f_nope=a', 'f_=a', 'f_on_hand=1', 'sort=nope', 'sort=on_hand&order=up', `f_model=${enc('a\u0001b')}`, `f_model=${'x'.repeat(101)}`, 'f_model=a&f_model=b', 'pageSize=201']) {
      const r = await slist('admin', qs);
      expect(r.status, qs).toBe(400);
      expect(r.data.items, qs).toBeUndefined();
    }
  });

  it('부서 범위와 기업 격리', async () => {
    expect(await keys('hroper', 'f_department=IT')).toEqual([]);
    expect(await keys('hroper', 'qField=model&q=M1')).toEqual(['M1@HR']);
    expect(await keys('hroper', 'q=Logi')).toEqual(['M1@HR']);
    const mine = new Set((((await slist('admin', 'pageSize=200')).data.items) as Stock[]).map((s) => s.id));
    const theirs = ((await slist('badmin', 'qField=model&q=M1&pageSize=200')).data.items as Stock[]).map((s) => s.id);
    expect(theirs).toHaveLength(2);
    for (const t of theirs) expect(mine.has(t)).toBe(false);
    expect((await slist('badmin', 'f_model=HDMI')).data.total).toBe(1);
  });
});

// ─────────────────────────── 실행 계획: 한 번 훑기, N+1 없음 ───────────────────────────

describe('자산 목록의 쿼리는 기업의 자산을 한 번만 훑는다 (앱 역할 + 기업 문맥)', () => {
  it('자산 2,000대인 기업에서 목록·건수·요약 쿼리가 각각 asset 을 2,000행 이하로 읽고, 쿼리 수는 고정이다', async () => {
    const C = await makeCompany('LSPERF');
    const D = await makeCompany('LSPERFD');
    const o = await owner();
    for (const [co, n] of [[C, 2000], [D, 5000]] as const) {
      await o.query("INSERT INTO app.department (company_id, name) SELECT $1, 'Dept ' || g FROM generate_series(1, 20) g", [co.id]);
      await o.query("INSERT INTO app.category (company_id, kind, name) SELECT $1, 'ASSET', 'Cat ' || g FROM generate_series(1, 10) g", [co.id]);
      await o.query(
        "INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) SELECT $1, c.id, 'ASSET', 'Maker ' || (g % 7), c.name || ' M' || g FROM app.category c, generate_series(1, 5) g WHERE c.company_id = $1",
        [co.id],
      );
      await o.query("INSERT INTO app.person (company_id, employee_no, name) SELECT $1, 'E' || g, 'Person ' || g FROM generate_series(1, 800) g", [co.id]);
      await o.query("INSERT INTO app.custom_field_def (company_id, key, label) VALUES ($1, 'mac', 'MAC')", [co.id]);
      await o.query(
        `WITH m AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS i FROM app.item_model WHERE company_id = $1),
              d AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS i FROM app.department WHERE company_id = $1),
              p AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS i FROM app.person WHERE company_id = $1)
         INSERT INTO app.asset (company_id, model_id, asset_tag, serial_number, state, substate, department_id, location, holder_person_id, supplier, custom)
         SELECT $1, m.id, 'TAG-' || lpad(g::text, 5, '0'), 'SN' || g,
                CASE WHEN g % 3 = 0 THEN 'IN_USE' ELSE 'IN_STOCK' END, CASE WHEN g % 3 = 0 THEN NULL ELSE 'AVAILABLE' END,
                d.id, 'Floor ' || (g % 12), CASE WHEN g % 3 = 0 THEN p.id END, 'Vendor ' || (g % 9), jsonb_build_object('mac', 'aa:' || g)
           FROM generate_series(1, $2::int) g
           JOIN m ON m.i = g % 50 JOIN d ON d.i = g % 21 JOIN p ON p.i = g % 800`,
        [co.id, n],
      );
    }
    await o.query('ANALYZE app.asset');

    const c = new pg.Client({ connectionString: process.env.TEST_OWNER_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await c.query("SELECT set_config('app.company_id', $1, true), set_config('app.system', 'off', true)", [C.id]);
      const captured: { text: string; params: unknown[] }[] = [];
      const db: Db = {
        query: async (text: string, params?: unknown[]) => {
          captured.push({ text, params: params ?? [] });
          return c.query(text, params as unknown[]) as never;
        },
      };
      const all: DataAccess = { scope: null, unrestricted: true, canReadField: () => true, canUpdateField: () => true, inScope: () => true };
      const actor = { companyId: C.id, userId: C.adminUserId } as unknown as Actor;
      const read = async (text: string, params: unknown[]) => {
        await c.query('SAVEPOINT x');
        const { rows } = await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params);
        await c.query('ROLLBACK TO SAVEPOINT x');
        let total = 0;
        const walk = (n: any) => {
          if (n['Relation Name'] === 'asset') total += ((n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0) + (n['Rows Removed by Index Recheck'] ?? 0)) * (n['Actual Loops'] ?? 1);
          for (const ch of n.Plans ?? []) walk(ch);
        };
        walk(rows[0]['QUERY PLAN'][0].Plan);
        return total;
      };
      for (const query of [
        { pageSize: 50 },
        { q: 'floor 1', filters: { manufacturer: 'maker', serial: '1', 'cf.mac': 'aa:1' }, sort: 'location' as const, order: 'desc' as const, page: 3, pageSize: 50 },
        { q: 'person 1', qField: 'holder', sort: 'supplier' as const, pageSize: 200 },
      ]) {
        captured.length = 0;
        const r = await listAssets(db, actor, all, query);
        expect(r.items.length).toBeGreaterThan(0);
        const assetQueries = captured.filter((x) => x.text.includes('FROM app.asset a'));
        expect(captured.length, JSON.stringify(query)).toBe(4); // 사용자 지정 필드 정의 + 건수 + 목록 + 요약
        expect(assetQueries).toHaveLength(3);
        for (const x of assetQueries) expect(await read(x.text, x.params), x.text.slice(0, 40)).toBeLessThanOrEqual(2000);
      }
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  }, 60000);
});
