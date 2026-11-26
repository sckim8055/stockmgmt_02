// 대시보드 v2: 조건(교차 필터), 묶음 기준, 구간, 이력 추이, 주변기기 패널, 주의 목록.
// 지키려는 것
//  - 대시보드의 수 = 같은 조건으로 연 자산 목록의 전체 건수(막대·조각·구간마다). "목록 보기"가 정확하다는 증거.
//  - 조건은 AND 로 겹친다. 부서 범위는 모든 패널(이력 추이 포함)에 걸린다. 다른 기업의 자료·사용자 지정 필드 키는 쓰지 못한다.
//  - 제한된 사용자 지정 필드는 읽을 권한이 없으면 기준·조건으로 쓸 수 없고(403) fields 에도 없다. 모르는 이름·값은 400.
//  - 구역은 그 자료의 조회 권한이 있어야 채워진다. 대시보드 권한이 없으면 403. 한 번 부를 때의 쿼리 수에 상한이 있다.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as assetsList } from '@/app/api/assets/route';
import { GET as dashboardRoute } from '@/app/api/dashboard/route';
import type { DataAccess } from '@/lib/authz/scope';
import type { Db } from '@/lib/db/context';
import { closePool } from '@/lib/db/pool';
import type { Actor } from '@/lib/http/route';
import { loadDashboard } from '@/lib/reports/dashboard';
import {
  addFilter, assetsHref, clearFilters, effectiveFilters, historyHref, importsExcluded, peripheralsHref, removeFilter, retiredExcluded, setImportsExcluded, setRetiredExcluded,
} from '@/app/(app)/_dashboard/filters';
import { APP_ROLE, call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};
let today = '';
const TZ = 'Asia/Seoul';

type Handler = (req: Request) => Promise<Response>;
const get = (h: Handler, as: string, path: string) => call(h, { cookie: cookie[as], path });
const dash = async (as: string, qs = '') => {
  const r = await get(dashboardRoute, as, `/api/dashboard?${qs}`);
  expect(r.status, `${as} ${qs}: ${JSON.stringify(r.data)}`).toBe(200);
  return r.data;
};
const listTotal = async (as: string, params: URLSearchParams) => {
  const p = new URLSearchParams(params);
  p.set('pageSize', '1');
  const r = await get(assetsList, as, `/api/assets?${p}`);
  expect(r.status, `${as} ${p}: ${JSON.stringify(r.data)}`).toBe(200);
  return r.data.total as number;
};
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** blank= 는 쉼표로 이은 한 값이다. 이미 있으면 덧붙인다. */
function withParam(params: URLSearchParams, key: string, value: string): URLSearchParams {
  const p = new URLSearchParams(params);
  const blank = p.get('blank')?.split(',') ?? [];
  const cur = p.get(key);
  if (key === 'blank' && blank.length) p.set('blank', [...new Set([...blank, value])].join(','));
  // 날짜 범위는 겹치는 부분(화면도 같다): 시작은 늦은 쪽, 끝은 이른 쪽
  else if (cur && /From$/.test(key)) p.set(key, cur > value ? cur : value);
  else if (cur && /To$/.test(key)) p.set(key, cur < value ? cur : value);
  else p.set(key, value);
  return p;
}

const rangeOk = (p: URLSearchParams, f: 'purchase' | 'warranty') => {
  const from = p.get(`${f}From`);
  const to = p.get(`${f}To`);
  const none = p.get(f === 'purchase' ? 'noPurchaseDate' : 'noWarrantyEnd');
  return !(from && to && from > to) && !(none && (from || to));
};

/** 묶음 하나를 목록 조건으로(화면의 page.tsx 와 같은 번역). */
function groupParam(dimension: string, key: string | null): [string, string] {
  switch (dimension) {
    case 'category': return ['categoryId', key!];
    case 'model': return ['modelId', key!];
    case 'department': return ['departmentId', key!];
    case 'manufacturer': return ['eq_manufacturer', key!];
    case 'holder': return ['hasHolder', key!];
    case 'location': return key === null ? ['blank', 'location'] : ['eq_location', key];
    default: return key === null ? ['blank', dimension] : [`eq_${dimension}`, key];
  }
}

// ───────────────────────── 자료 ─────────────────────────

interface Seed {
  tag: string;
  model: 'x1' | 'xps' | 'u27' | 'p1';
  dept: 'it' | 'hr' | 'ops';
  state: string;
  substate: string | null;
  holder: string | null;
  location: string | null;
  pdate: string | null;
  wend: string | null;
  due: string | null;
  custom: Record<string, string>;
}
const seeds: Seed[] = [];
const MODEL_CAT = { x1: 'laptop', xps: 'laptop', u27: 'monitor', p1: 'phone' } as const;
const MODEL_MAKER = { x1: 'Lenovo', xps: 'Dell', u27: 'DELL', p1: 'Dell Technologies' } as const;

async function insertAsset(c: TestCompany, model: string, dept: string, s: Omit<Seed, 'model' | 'dept'>): Promise<string> {
  const o = await owner();
  return (await o.query(
    `INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate, department_id, location, holder_person_id, purchase_date, warranty_end, due_date, custom, supplier, purchase_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'SecretVendorX', 7777777) RETURNING id`,
    [c.id, model, s.tag, s.state, s.substate, dept, s.location, s.holder, s.pdate, s.wend, s.due, JSON.stringify(s.custom)],
  )).rows[0].id;
}

async function role(c: TestCompany, loginId: string, acl: [string, string][], depts: string[] = []): Promise<void> {
  const o = await owner();
  const uid = await makeUser(c.id, loginId, 'COMPANY_USER');
  const r = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [c.id, uniq('role')])).rows[0].id;
  for (const [res, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [r, res, op]);
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [uid, r, c.id]);
  for (const d of depts) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [uid, d, c.id]);
  cookie[loginId] = await sessionFor(c.code, loginId);
}

const FULL: [string, string][] = [
  ['dashboard', 'read'], ['asset.item', 'read'], ['history.stock', 'read'], ['peripheral.stock', 'read'], ['peripheral.loan', 'read'], ['threshold', 'read'],
];

/** 이번 달부터 k 달 전 달의 첫날 + 1시간(기업 시간대) */
const monthAgo = (k: number) => `(date_trunc('month', now() AT TIME ZONE '${TZ}') - make_interval(months => ${k}) + interval '1 hour') AT TIME ZONE '${TZ}'`;

beforeAll(async () => {
  A = await makeCompany('DSHA');
  B = await makeCompany('DSHB');
  const o = await owner();
  await o.query('UPDATE app.company SET timezone = $2 WHERE id = $1', [A.id, TZ]);
  today = (await o.query(`SELECT (now() AT TIME ZONE '${TZ}')::date::text AS d`)).rows[0].d;
  const q = async (sql: string, p: unknown[]) => (await o.query(sql, p)).rows[0].id as string;
  id.it = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A.id])).rows[0].id;
  id.hr = await q("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [A.id]);
  id.ops = await q("INSERT INTO app.department (company_id, name) VALUES ($1, 'OPS') RETURNING id", [A.id]);
  id.laptop = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [A.id]);
  id.monitor = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Monitor') RETURNING id", [A.id]);
  id.phone = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Phone') RETURNING id", [A.id]);
  id.mouse = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Mouse') RETURNING id", [A.id]);
  id.cable = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Cable') RETURNING id", [A.id]);
  const model = (cat: string, maker: string, name: string, kind = 'ASSET') =>
    q('INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, $3, $4, $5) RETURNING id', [A.id, cat, kind, maker, name]);
  id.x1 = await model(id.laptop, 'Lenovo', 'X1');
  id.xps = await model(id.laptop, 'Dell', 'XPS');
  id.u27 = await model(id.monitor, 'DELL', 'U27');
  id.p1 = await model(id.phone, 'Dell Technologies', 'P1');
  id.m1 = await model(id.mouse, 'Logi', 'M1', 'PERIPHERAL');
  id.c1 = await model(id.cable, 'Belkin', 'C1', 'PERIPHERAL');
  id.kim = await q("INSERT INTO app.person (company_id, name) VALUES ($1, 'Kim') RETURNING id", [A.id]);
  id.lee = await q("INSERT INTO app.person (company_id, name) VALUES ($1, 'Lee') RETURNING id", [A.id]);
  await o.query(
    "INSERT INTO app.custom_field_def (company_id, key, label, data_type, is_restricted, is_active) VALUES ($1, 'status_actual', 'Actual status', 'text', false, true), ($1, 'account', 'Account', 'text', true, true), ($1, 'gone', 'Gone', 'text', false, false)",
    [A.id],
  );

  // 자산 66대(+ 등록 취소 2대). 상태·부서·모델·위치·구매일·보증·사용자 지정 필드가 서로 다른 주기로 섞인다.
  const STATES: [string, string | null][] = [
    ['IN_USE', null], ['IN_STOCK', 'AVAILABLE'], ['IN_STOCK', 'RESERVED'], ['IN_STOCK', 'DEFECTIVE'], ['MAINTENANCE', null], ['MISSING', null],
    ['ON_ORDER', null], ['RETIRED', 'DISPOSED'], ['IN_USE', null], ['IN_STOCK', 'AVAILABLE'], ['RETIRED', 'PENDING_DISPOSAL'],
  ];
  const W = [-10, 0, 15, 30, 31, 60, 90, 91, 200, 365, 366, 800, null];
  const year = Number(today.slice(0, 4));
  for (let i = 0; i < 66; i++) {
    const [state, substate] = STATES[i % 11]!;
    const holder = state === 'IN_USE' ? (i % 2 ? id.kim! : id.lee!) : state === 'IN_STOCK' ? null : i % 2 ? id.kim! : null;
    const s: Seed = {
      tag: `DA-${String(i).padStart(3, '0')}`,
      model: (['x1', 'xps', 'u27', 'p1'] as const)[i % 4]!,
      dept: (['it', 'hr', 'ops'] as const)[i % 3]!,
      state, substate, holder,
      location: i === 2 ? 'Seoul 3F' : i === 7 ? 'seoul 3f' : i % 5 === 0 ? null : i % 5 === 1 ? '   ' : `Loc-${i % 17}`,
      pdate: i % 6 === 0 ? null : i === 1 ? '2005-03-01' : i === 4 ? `${year + 1}-02-01` : `${year - (i % 9)}-0${1 + (i % 9)}-15`,
      wend: W[i % 13] === null ? null : addDays(today, W[i % 13] as number),
      due: state === 'IN_USE' ? addDays(today, i % 4 === 0 ? -3 : 10) : null,
      custom: {
        ...(i % 4 === 1 ? { status_actual: 'OK' } : i % 4 === 2 ? { status_actual: 'Broken' } : i % 4 === 3 ? { status_actual: '  ' } : {}),
        ...(i % 3 === 0 ? { account: `acc-secret-${i}` } : {}),
        gone: 'zzz',
      },
    };
    seeds.push(s);
    id[s.tag] = await insertAsset(A, id[s.model]!, id[s.dept]!, s);
  }
  for (const tag of ['DA-V1', 'DA-V2']) await insertAsset(A, id.x1!, id.it!, { tag, state: 'VOID', substate: null, holder: null, location: 'Loc-1', pdate: null, wend: today, due: null, custom: {} });

  // 이력: IT 노트북(DA-001, x1·it? → i=1 은 xps·hr). 부서가 다른 두 자산을 고른다.
  const itLaptop = seeds.find((s) => s.dept === 'it' && MODEL_CAT[s.model] === 'laptop')!;
  const hrMonitor = seeds.find((s) => s.dept === 'hr' && MODEL_CAT[s.model] === 'monitor')!;
  id.itLaptop = id[itLaptop.tag]!;
  id.hrMonitor = id[hrMonitor.tag]!;
  for (const k of [0, 1, 2, 5, 11, 13]) {
    for (let j = 0; j <= k % 4; j++) await o.query(`INSERT INTO app.asset_txn (company_id, asset_id, type, created_at) VALUES ($1, $2, 'ASSIGN', ${monthAgo(k)})`, [A.id, id.itLaptop]);
    await o.query(`INSERT INTO app.asset_txn (company_id, asset_id, type, created_at) VALUES ($1, $2, 'REPAIR_IN', ${monthAgo(k)}), ($1, $2, 'RETURN', ${monthAgo(k)})`, [A.id, id.hrMonitor]);
  }

  // 주변기기: IT 마우스 10(대여 2), HR 마우스 4, HR 케이블 7(대여 1). 이력은 IT 3건(이번 달), HR 1건(지난달).
  const stock = (m: string, d: string, h: number, l: number) =>
    q('INSERT INTO app.peripheral_stock (company_id, model_id, department_id, on_hand_qty, on_loan_qty) VALUES ($1, $2, $3, $4, $5) RETURNING id', [A.id, m, d, h, l]);
  id.sItMouse = await stock(id.m1!, id.it!, 10, 2);
  id.sHrMouse = await stock(id.m1!, id.hr!, 4, 0);
  id.sHrCable = await stock(id.c1!, id.hr!, 7, 1);
  for (let j = 0; j < 3; j++) await o.query(`INSERT INTO app.peripheral_txn (company_id, stock_id, type, qty, created_at) VALUES ($1, $2, 'RECEIVE', 1, ${monthAgo(0)})`, [A.id, id.sItMouse]);
  await o.query(`INSERT INTO app.peripheral_txn (company_id, stock_id, type, qty, created_at) VALUES ($1, $2, 'ISSUE', -1, ${monthAgo(1)})`, [A.id, id.sHrCable]);
  await o.query("INSERT INTO app.peripheral_loan (company_id, stock_id, person_id, qty, due_date) VALUES ($1, $2, $3, 1, current_date - 2)", [A.id, id.sHrCable, id.kim]);
  await o.query("INSERT INTO app.peripheral_loan (company_id, stock_id, person_id, qty, due_date) VALUES ($1, $2, $3, 2, current_date + 9)", [A.id, id.sItMouse, id.lee]);
  // 한계 수량: 기업 전체 마우스(부족), HR 케이블(부족), HR 마우스(정상)
  await o.query("INSERT INTO app.stock_threshold (company_id, model_id, department_id, min_qty, state) VALUES ($1, $2, NULL, 100, 'LOW'), ($1, $3, $4, 50, 'LOW'), ($1, $2, $4, 1, 'OK')", [A.id, id.m1, id.c1, id.hr]);

  // 다른 기업: 자산 3대, 자기만의 사용자 지정 필드
  const bcat = (await o.query("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'BLaptop') RETURNING id", [B.id])).rows[0].id;
  const bmodel = (await o.query("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Dell', 'BX') RETURNING id", [B.id, bcat])).rows[0].id;
  const bdept = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [B.id])).rows[0].id;
  await o.query("INSERT INTO app.custom_field_def (company_id, key, label, data_type) VALUES ($1, 'bonly', 'B only', 'text')", [B.id]);
  for (let i = 0; i < 3; i++) {
    await insertAsset(B, bmodel, bdept, { tag: `DB-${i}`, state: 'IN_STOCK', substate: 'AVAILABLE', holder: null, location: 'Seoul 3F', pdate: null, wend: null, due: null, custom: { bonly: 'b', status_actual: 'OK' } });
  }

  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  await role(A, 'full', FULL);
  await role(A, 'fullr', [...FULL, ['asset.item.custom_restricted', 'read']]);
  await role(A, 'hruser', FULL, [id.hr!]);
  await role(A, 'dashonly', [['dashboard', 'read']]);
  await role(A, 'assetonly', [['dashboard', 'read'], ['asset.item', 'read']]);
  await role(A, 'nodash', [['asset.item', 'read'], ['history.stock', 'read']]);
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

// ───────────────────────── 정확한 드릴다운 ─────────────────────────

const DIMENSIONS = ['category', 'manufacturer', 'model', 'department', 'location', 'holder', 'cf.status_actual'];

/** 대시보드의 모든 수(도넛·묶음·연도·보증·핵심 수치)가 같은 조건의 자산 목록 전체 건수와 같은지 본다. */
async function expectExact(as: string, base: URLSearchParams) {
  const all = await listTotal(as, base);
  for (const dimension of DIMENSIONS) {
    const d = await dash(as, withParam(base, 'dimension', dimension).toString());
    const a = d.assets;
    expect(a.total, `${as} ${base} total`).toBe(all);
    expect(a.kpi.total).toBe(all);
    const groups = a.breakdown.groups as { key: string | null; total: number }[];
    expect(groups.length).toBeLessThanOrEqual(12);
    expect(groups.reduce((n, g) => n + g.total, 0) + (a.breakdown.other?.total ?? 0), `${dimension}: 묶음의 합 = 전체`).toBe(all);
    for (const g of groups) {
      const [k, v] = groupParam(dimension, g.key);
      expect(await listTotal(as, withParam(base, k, v)), `${as} ${base} ${dimension}=${g.key}`).toBe(g.total);
    }
    if (dimension !== 'category') continue;
    // 도넛: 상태 조건을 뺀 상태별 수 → 상태(·세부 상태) 조건을 건 목록
    const noState = new URLSearchParams(base);
    noState.delete('state');
    noState.delete('substate');
    for (const s of a.byState as { state: string; substate: string | null; n: number }[]) {
      let p = withParam(noState, 'state', s.state);
      if (s.substate) p = withParam(p, 'substate', s.substate);
      expect(await listTotal(as, p), `${as} donut ${s.state}/${s.substate}`).toBe(s.n);
    }
    // 구매 연도
    const ages = a.age as { kind: string; n: number; from: string | null; to: string | null }[];
    expect(ages.reduce((n, b) => n + b.n, 0)).toBe(all);
    for (const b of ages) {
      let p = base;
      if (b.kind === 'unknown') p = withParam(p, 'noPurchaseDate', 'true');
      if (b.from) p = withParam(p, 'purchaseFrom', b.from);
      if (b.to) p = withParam(p, 'purchaseTo', b.to);
      if (b.n === 0 && !rangeOk(p, 'purchase')) continue; // 조건과 겹치지 않는 구간(0, 화면에서도 누를 수 없다)
      expect(await listTotal(as, p), `${as} age ${b.kind} ${b.from}~${b.to}`).toBe(b.n);
    }
    // 보증 구간(퇴역 제외 → active=true)
    const ws = a.warranty as { key: string; n: number; from: string | null; to: string | null }[];
    const activeBase = withParam(base, 'active', 'true');
    expect(ws.reduce((n, b) => n + b.n, 0)).toBe(await listTotal(as, activeBase));
    for (const b of ws) {
      let p = activeBase;
      if (b.key === 'none') p = withParam(p, 'noWarrantyEnd', 'true');
      if (b.from) p = withParam(p, 'warrantyFrom', b.from);
      if (b.to) p = withParam(p, 'warrantyTo', b.to);
      if (b.n === 0 && !rangeOk(p, 'warranty')) continue;
      expect(await listTotal(as, p), `${as} warranty ${b.key}`).toBe(b.n);
    }
    // 핵심 수치
    expect(await listTotal(as, withParam(base, 'overdue', 'true'))).toBe(a.overdue);
    expect(a.warrantySoon).toBe(ws.find((b) => b.key === 'soon')!.n);
  }
}

describe('대시보드의 수 = 같은 조건의 자산 목록 전체 건수', () => {
  it('조건 없음: 모든 기준·구간·조각', async () => {
    expect(await listTotal('admin', new URLSearchParams())).toBe(66); // 등록 취소 2대는 빠진다
    await expectExact('admin', new URLSearchParams());
  });

  it('조건을 겹쳐도(AND) 같다: 카테고리 + 보유자 있음, 상태 + 값 없음 위치, 사용자 지정 필드 + 구매 연도', async () => {
    await expectExact('admin', new URLSearchParams({ categoryId: id.laptop!, hasHolder: 'true' }));
    await expectExact('admin', new URLSearchParams({ state: 'IN_STOCK', blank: 'location' }));
    await expectExact('admin', new URLSearchParams({ 'eq_cf.status_actual': 'OK', purchaseFrom: `${today.slice(0, 4)}-01-01` }));
    // 보증 구간에서 들어온 조건(퇴역 제외 + 범위) 위에서도
    await expectExact('admin', new URLSearchParams({ active: 'true', warrantyFrom: today, warrantyTo: addDays(today, 400), blank: 'cf.status_actual' }));
  });

  it('부서 범위가 제한된 사용자도 같다(범위 안에서)', async () => {
    await expectExact('hruser', new URLSearchParams());
    await expectExact('hruser', new URLSearchParams({ eq_manufacturer: 'Dell' }));
  });

  it('겹친 조건은 AND: 씨앗 자료로 직접 센 수와 같다', async () => {
    const want = seeds.filter((s) => MODEL_CAT[s.model] === 'laptop' && s.holder !== null && s.dept !== 'ops' && s.custom.status_actual === 'OK').length;
    const qs = new URLSearchParams({ categoryId: id.laptop!, hasHolder: 'true', 'eq_cf.status_actual': 'OK' });
    const d = await dash('admin', qs.toString());
    const withoutOps = seeds.filter((s) => MODEL_CAT[s.model] === 'laptop' && s.holder !== null && s.custom.status_actual === 'OK').length;
    expect(d.assets.total).toBe(withoutOps);
    const byDept = await dash('admin', withParam(qs, 'dimension', 'department').toString());
    const notOps = (byDept.assets.breakdown.groups as { key: string; total: number }[]).filter((g) => g.key !== id.ops).reduce((n, g) => n + g.total, 0);
    expect(notOps).toBe(want);
    // 한 조건만 건 것보다 많을 수 없다
    expect(d.assets.total).toBeLessThanOrEqual((await dash('admin', `categoryId=${id.laptop}`)).assets.total);
  });

  it('제조사는 정확히 같은 값으로 묶는다(Dell, DELL, Dell Technologies 는 다른 묶음). 목록의 f_manufacturer(포함)와는 다르다', async () => {
    const d = await dash('admin', 'dimension=manufacturer');
    const keys = (d.assets.breakdown.groups as { key: string }[]).map((g) => g.key).sort();
    expect(keys).toEqual(['DELL', 'Dell', 'Dell Technologies', 'Lenovo']);
    const dell = d.assets.breakdown.groups.find((g: { key: string }) => g.key === 'Dell').total;
    expect(await listTotal('admin', new URLSearchParams({ eq_manufacturer: 'Dell' }))).toBe(dell);
    expect(await listTotal('admin', new URLSearchParams({ f_manufacturer: 'Dell' }))).toBeGreaterThan(dell);
    // 위치도: 'Seoul 3F' 와 'seoul 3f' 는 다른 묶음, 공백뿐인 값은 "값 없음"
    const loc = await dash('admin', 'dimension=location');
    const lk = (loc.assets.breakdown.groups as { key: string | null }[]).map((g) => g.key);
    expect(lk).toContain(null);
    expect(lk).not.toContain('   ');
    expect(seeds.filter((s) => s.location === null || s.location.trim() === '').length).toBe(loc.assets.breakdown.groups.find((g: { key: string | null }) => g.key === null).total);
    // 묶음이 12개를 넘으면 나머지는 "기타" 하나
    expect(loc.assets.breakdown.groups.length).toBe(12);
    expect(loc.assets.breakdown.other.groups).toBeGreaterThan(0);
  });

  it('상태 조건: 핵심 수치는 상태 조건까지, 도넛은 상태 조건을 뺀 수', async () => {
    const d = await dash('admin', 'state=IN_USE');
    expect(d.assets.kpi).toMatchObject({ total: d.assets.total, inUse: d.assets.total, available: 0, missing: 0 });
    expect(new Set(d.assets.byState.map((s: { state: string }) => s.state)).size).toBeGreaterThan(3);
    expect(d.assets.total).toBe(seeds.filter((s) => s.state === 'IN_USE').length);
  });
});

// ───────────────────────── 범위·격리·권한 ─────────────────────────

describe('부서 범위', () => {
  it('모든 패널이 범위 안의 것만 센다', async () => {
    const d = await dash('hruser', 'dimension=department');
    expect(d.scoped).toBe(true);
    expect(d.assets.total).toBe(seeds.filter((s) => s.dept === 'hr').length);
    expect(d.assets.breakdown.groups.map((g: { key: string }) => g.key)).toEqual([id.hr]);
    const att = [...d.assets.attention.overdue, ...d.assets.attention.warranty, ...d.assets.attention.missing] as { department_name: string }[];
    expect(att.length).toBeGreaterThan(0);
    expect(att.every((r) => r.department_name === 'HR')).toBe(true);
    expect(d.peripherals).toEqual({ onHand: 11, onLoan: 1, stockRows: 2 });
    expect(d.loans).toEqual({ open: 1, overdue: 1 });
    expect(d.thresholds).toEqual({ active: 2, low: 1 }); // 기업 전체 한계 수량은 보이지 않는다
    expect(d.lowStock.map((r: { model_id: string }) => r.model_id)).toEqual([id.c1]);
  });

  it('범위 밖 부서를 조건으로 걸면 0 이고, 이름도 알려 주지 않는다', async () => {
    const d = await dash('hruser', `departmentId=${id.it}`);
    expect(d.assets.total).toBe(0);
    expect(d.peripherals.onHand).toBe(0);
    expect(d.labels.department).toBeNull();
    expect((await dash('admin', `departmentId=${id.it}`)).labels.department).toBe('IT');
  });

  it('이력 추이도 범위를 따른다(자산은 지금의 관리 부서, 주변기기는 재고 행의 부서)', async () => {
    const sum = (rows: { n: number }[]) => rows.reduce((n, r) => n + r.n, 0);
    const admin = (await dash('admin', 'trendMonths=12')).trend;
    const hr = (await dash('hruser', 'trendMonths=12')).trend;
    expect(admin.months.length).toBe(12);
    // IT 노트북: 0,1,2,5,11 달 전에 (k%4+1)건 = 1+2+3+2+4 = 12, HR 모니터: 5달 × 2건 = 10 (13달 전 것은 기간 밖)
    expect(sum(admin.asset)).toBe(22);
    expect(sum(hr.asset)).toBe(10);
    expect(hr.asset.every((r: { type: string }) => r.type === 'REPAIR_IN' || r.type === 'RETURN')).toBe(true);
    expect(sum(admin.peripheral)).toBe(4);
    expect(sum(hr.peripheral)).toBe(1);
    // 자산 조건도 이력 추이에 걸린다(지금 그 조건에 맞는 자산의 이력)
    expect(sum((await dash('admin', `categoryId=${id.laptop}`)).trend.asset)).toBe(12);
    // 기간: 3달이면 0,1,2 달 전만
    const t3 = (await dash('admin', 'trendMonths=3')).trend;
    expect(t3.months.length).toBe(3);
    expect(sum(t3.asset)).toBe(1 + 2 + 3 + 6);
    expect(t3.months[2]).toBe(`${today.slice(0, 7)}-01`);
    // 주변기기 추이에는 부서 조건만 걸린다
    expect(sum((await dash('admin', `departmentId=${id.hr}`)).trend.peripheral)).toBe(1);
  });

  it('주변기기 패널은 부서 조건을 따른다', async () => {
    const all = await dash('admin');
    expect(all.peripherals).toEqual({ onHand: 21, onLoan: 3, stockRows: 3 });
    expect(all.peripheralCategories.rows.map((r: { name: string; onHand: number; onLoan: number }) => [r.name, r.onHand, r.onLoan])).toEqual([['Mouse', 14, 2], ['Cable', 7, 1]]);
    expect(all.lowStock.map((r: { model_id: string }) => r.model_id)).toEqual([id.m1, id.c1]); // 모자란 수가 큰 것부터
    expect(all.loans).toEqual({ open: 2, overdue: 1 });
    const hr = await dash('admin', `departmentId=${id.hr}`);
    expect(hr.peripherals).toEqual({ onHand: 11, onLoan: 1, stockRows: 2 });
    expect(hr.lowStock.map((r: { model_id: string }) => r.model_id)).toEqual([id.c1]);
    expect(hr.loans).toEqual({ open: 1, overdue: 1 });
  });
});

describe('기업 격리', () => {
  it('다른 기업의 자료는 보이지 않고, 그 기업의 사용자 지정 필드 키는 400', async () => {
    const b = await dash('badmin', 'dimension=cf.bonly');
    expect(b.assets.total).toBe(3);
    expect(b.assets.breakdown.groups).toEqual([expect.objectContaining({ key: 'b', total: 3 })]);
    expect(b.peripherals).toEqual({ onHand: 0, onLoan: 0, stockRows: 0 });
    expect(b.trend.asset).toEqual([]);
    expect(b.lowStock).toEqual([]);
    expect(JSON.stringify(b)).not.toMatch(/DA-0|Lenovo|acc-secret|Loc-/);
    expect((await get(dashboardRoute, 'badmin', '/api/dashboard?dimension=cf.status_actual')).status).toBe(400);
    expect((await get(dashboardRoute, 'badmin', '/api/dashboard?eq_cf.status_actual=OK')).status).toBe(400);
    expect((await get(dashboardRoute, 'admin', '/api/dashboard?dimension=cf.bonly')).status).toBe(400);
    expect((await get(assetsList, 'admin', '/api/assets?eq_cf.bonly=b')).status).toBe(400);
    // 다른 기업의 ID 를 조건으로: 0, 이름 없음
    const x = await dash('badmin', `categoryId=${id.laptop}&departmentId=${id.hr}`);
    expect(x.assets.total).toBe(0);
    expect(x.labels).toEqual({ category: null, model: null, department: null });
  });
});

describe('제한된 사용자 지정 필드', () => {
  it('읽을 권한이 없으면 기준·조건으로 쓸 수 없고(403) fields 에도 없다', async () => {
    const d = await dash('full');
    expect(d.assets.fields.custom.map((c: { key: string }) => c.key)).toEqual(['status_actual']);
    expect(JSON.stringify(d)).not.toMatch(/acc-secret|SecretVendorX|7777777|account/);
    for (const qs of ['dimension=cf.account', 'eq_cf.account=x', 'blank=cf.account']) {
      expect((await get(dashboardRoute, 'full', `/api/dashboard?${qs}`)).status, qs).toBe(403);
    }
    expect((await get(assetsList, 'full', '/api/assets?blank=cf.account')).status).toBe(403);
    // 비활성 필드는 정의가 없는 것과 같다
    expect((await get(dashboardRoute, 'admin', '/api/dashboard?dimension=cf.gone')).status).toBe(400);
  });

  it('읽을 권한이 있으면 기준으로 쓸 수 있고 수가 목록과 같다', async () => {
    const d = await dash('fullr', 'dimension=cf.account');
    expect(d.assets.fields.custom.map((c: { key: string }) => c.key).sort()).toEqual(['account', 'status_actual']);
    const groups = d.assets.breakdown.groups as { key: string | null; total: number }[];
    expect(groups.find((g) => g.key === null)!.total).toBe(seeds.filter((s) => !s.custom.account).length);
    for (const g of groups.slice(0, 3)) {
      const [k, v] = groupParam('cf.account', g.key);
      expect(await listTotal('fullr', new URLSearchParams({ [k]: v }))).toBe(g.total);
    }
  });
});

describe('구역 권한과 잘못된 요청', () => {
  it('구역은 그 자료의 조회 권한이 있어야 채워지고, 대시보드 권한이 없으면 403', async () => {
    expect(await dash('dashonly')).toMatchObject({ assets: null, trend: null, peripherals: null, peripheralCategories: null, loans: null, thresholds: null, lowStock: null });
    const a = await dash('assetonly');
    expect(a.assets.total).toBe(66);
    expect(a).toMatchObject({ trend: null, peripherals: null, loans: null, thresholds: null, lowStock: null });
    expect((await get(dashboardRoute, 'nodash', '/api/dashboard')).status).toBe(403);
    expect((await call(dashboardRoute, { path: '/api/dashboard' })).status).toBe(401);
  });

  it('모르는 기준·매개변수·잘못된 값은 400', async () => {
    const bad = [
      'dimension=supplier', 'dimension=purchase_price', 'dimension=cf.nope', 'dimension=cf.Bad', 'trendMonths=5', 'foo=1', 'state=VOID', 'state=x',
      'categoryId=nope', 'purchaseFrom=2024-13-01', 'purchaseFrom=2025-01-02&purchaseTo=2025-01-01', 'noPurchaseDate=false', 'noPurchaseDate=true&purchaseFrom=2020-01-01',
      'hasHolder=maybe', 'eq_supplier=x', 'eq_serial=x', 'blank=serial', 'blank=location,location', 'eq_location=a&blank=location', 'eq_location=',
      'state=IN_USE&state=MISSING', 'eq_manufacturer=a&eq_manufacturer=b', 'warrantyTo=2020-02-30', 'f_manufacturer=x',
    ];
    for (const qs of bad) expect((await get(dashboardRoute, 'admin', `/api/dashboard?${qs}`)).status, qs).toBe(400);
  });

  it('자산 목록의 새 조건도 같은 검사와 범위를 따른다', async () => {
    for (const qs of ['hasHolder=maybe', 'purchaseFrom=2024-02-30', 'noWarrantyEnd=1', 'eq_supplier=x', 'blank=model', 'active=yes', 'warrantyFrom=2026-02-02&warrantyTo=2026-01-01']) {
      expect((await get(assetsList, 'admin', `/api/assets?${qs}`)).status, qs).toBe(400);
    }
    // 범위: HR 사용자는 IT 에만 있는 위치로 찾아도 0
    const itOnly = seeds.find((s) => s.dept === 'it' && s.location && s.location.trim() && !seeds.some((o) => o.dept === 'hr' && o.location === s.location))!;
    expect(await listTotal('admin', new URLSearchParams({ eq_location: itOnly.location! }))).toBeGreaterThan(0);
    expect(await listTotal('hruser', new URLSearchParams({ eq_location: itOnly.location! }))).toBe(0);
    // active=true 는 퇴역을 뺀다, hasHolder=false 는 보유자 없는 것만
    expect(await listTotal('admin', new URLSearchParams({ active: 'true' }))).toBe(seeds.filter((s) => s.state !== 'RETIRED').length);
    expect(await listTotal('admin', new URLSearchParams({ hasHolder: 'false' }))).toBe(seeds.filter((s) => s.holder === null).length);
    // 공백까지 정확히: 'Seoul 3F' 는 'seoul 3f' 와 다르다
    expect(await listTotal('admin', new URLSearchParams({ eq_location: 'Seoul 3F' }))).toBe(1);
  });
});

// ───────────────────────── 쿼리 수 ─────────────────────────

/** 소유자 연결로 연 "앱 역할 + 기업 문맥" 트랜잭션(review5 와 같은 방식). 쿼리를 센다. */
async function tenantSession(companyId: string) {
  const c = new pg.Client({ connectionString: process.env.TEST_OWNER_URL });
  await c.connect();
  await c.query('BEGIN');
  await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await c.query("SELECT set_config('app.company_id', $1, true), set_config('app.system', 'off', true)", [companyId]);
  const captured: string[] = [];
  const db: Db = {
    query: async (text: string, params?: unknown[]) => {
      captured.push(text);
      return c.query(text, params as unknown[]) as never;
    },
  };
  return { db, captured, end: async () => { await c.query('ROLLBACK'); await c.end(); } };
}

const ALL: DataAccess = { scope: null, unrestricted: true, canReadField: () => true, canUpdateField: () => true, inScope: () => true };

describe('한 번 부를 때의 쿼리 수', () => {
  it('모든 구역 + 이름 조회 + 사용자 지정 기준이어도 15개 이하이고, 조건 수와 상관없다', async () => {
    const actor = { userId: A.adminUserId, companyId: A.id, isAdmin: true } as unknown as Actor;
    const s = await tenantSession(A.id);
    try {
      const d = await loadDashboard(s.db, actor, ALL, { dimension: 'cf.status_actual', categoryId: id.laptop, exact: { hasHolder: true, custom: { status_actual: 'OK' }, purchaseFrom: '2000-01-01' } });
      expect(d.assets && d.trend && d.peripherals && d.loans && d.thresholds && d.lowStock).toBeTruthy();
      expect(s.captured.length).toBeLessThanOrEqual(15);
      const n = s.captured.length;
      s.captured.length = 0;
      await loadDashboard(s.db, actor, ALL, {});
      expect(s.captured.length).toBe(n - 1); // 이름 조회만 빠진다
    } finally {
      await s.end();
    }
  });
});

describe('퇴역 제외(화면의 기본값: active=true)', () => {
  it('active=true 의 모든 패널·구간 = active=true 를 건 목록의 건수(관리자, 부서 범위 사용자, 다른 조건과 겹쳐도)', async () => {
    const active = new URLSearchParams({ active: 'true' });
    expect(await listTotal('admin', active)).toBe(seeds.filter((s) => s.state !== 'RETIRED').length);
    await expectExact('admin', active);
    await expectExact('hruser', active);
    await expectExact('admin', new URLSearchParams({ active: 'true', categoryId: id.laptop!, hasHolder: 'true' }));
    await expectExact('admin', new URLSearchParams({ active: 'true', state: 'IN_STOCK' }));
  });

  it('active=true 이면 도넛·핵심 수치에 퇴역이 없고, 나머지 상태의 수는 그대로다', async () => {
    const all = (await dash('admin')).assets;
    const act = (await dash('admin', 'active=true')).assets;
    expect(act.byState.some((r: { state: string }) => r.state === 'RETIRED')).toBe(false);
    expect(act.kpi.retired).toBe(0);
    expect(all.kpi.retired).toBe(seeds.filter((s) => s.state === 'RETIRED').length);
    expect(act.total).toBe(all.total - all.kpi.retired);
    expect({ ...act.kpi, retired: undefined, total: undefined }).toEqual({ ...all.kpi, retired: undefined, total: undefined });
  });

  it('화면의 켜고 끄기: 주소에 없으면 퇴역 제외·업로드 제외, 끈 것만 주소에 남고, 목록으로는 active=true 가 옮겨진다', () => {
    const none = new URLSearchParams();
    expect(retiredExcluded(none)).toBe(true);
    expect(importsExcluded(none)).toBe(true);
    expect(effectiveFilters(none).toString()).toBe('active=true');
    expect(assetsHref(effectiveFilters(new URLSearchParams({ categoryId: 'c', dimension: 'model' })))).toBe('/assets?categoryId=c&active=true');
    // 끄기 → retired=include, 다시 켜기 → 처음과 같다
    const off = setRetiredExcluded(new URLSearchParams({ categoryId: 'c' }), false);
    expect(off.toString()).toBe('categoryId=c&retired=include');
    expect(retiredExcluded(off)).toBe(false);
    expect(effectiveFilters(off).toString()).toBe('categoryId=c');
    expect(assetsHref(effectiveFilters(off))).toBe('/assets?categoryId=c');
    expect(setRetiredExcluded(off, true).toString()).toBe('categoryId=c');
    // 보증 구간에서 들어와 active=true 가 직접 걸린 경우: 켜짐으로 보이고, 끄면 active 도 지운다
    const wsp = new URLSearchParams({ retired: 'include', active: 'true', warrantyFrom: '2026-01-01' });
    expect(retiredExcluded(wsp)).toBe(true);
    expect(setRetiredExcluded(wsp, false).toString()).toBe('retired=include&warrantyFrom=2026-01-01');
    // 업로드 제외
    const io = setImportsExcluded(none, false);
    expect(io.toString()).toBe('imports=include');
    expect(importsExcluded(io)).toBe(false);
    expect(setImportsExcluded(io, true).toString()).toBe('');
    expect(effectiveFilters(io).has('imports')).toBe(false);
    // "모두 지우기"는 켜고 끄기를 남긴다
    expect(clearFilters(new URLSearchParams({ retired: 'include', imports: 'include', state: 'IN_USE', trendMonths: '3' })).toString()).toBe('trendMonths=3&retired=include&imports=include');
    // 이력 화면으로는 옮길 수 없다(설명에 나온다)
    expect(historyHref(effectiveFilters(none), 'ASSET', '2026-02-01').leftOut).toEqual(['active']);
  });
});

describe('화면의 조건 옮기기(_dashboard/filters.ts)', () => {
  it('드릴다운: 범위는 겹치는 부분만, 값과 "값 없음"은 서로 바꾸고, 목록 주소에는 화면 설정을 넣지 않는다', () => {
    let sp = new URLSearchParams({ dimension: 'location', trendMonths: '6', purchaseFrom: '2020-01-01' });
    sp = addFilter(sp, { purchaseFrom: '2019-01-01', purchaseTo: '2019-12-31' });
    expect(sp.get('purchaseFrom')).toBe('2020-01-01');
    expect(sp.get('purchaseTo')).toBe('2019-12-31');
    sp = addFilter(sp, { blank: 'location' });
    sp = addFilter(sp, { eq_location: 'A' });
    expect(sp.get('blank')).toBeNull();
    sp = addFilter(sp, { blank: 'cf.k' });
    expect(sp.get('blank')).toBe('cf.k');
    sp = addFilter(sp, { 'eq_cf.k': 'v' });
    expect(sp.get('blank')).toBeNull();
    sp = addFilter(sp, { state: 'IN_STOCK', substate: 'AVAILABLE' });
    sp = addFilter(sp, { state: 'IN_USE' });
    expect(sp.get('substate')).toBeNull();
    expect(removeFilter(addFilter(sp, { categoryId: 'c', modelId: 'm' }), 'categoryId').get('modelId')).toBeNull();
    const href = assetsHref(sp, { overdue: 'true' });
    expect(href).toMatch(/^\/assets\?/);
    expect(href).not.toMatch(/dimension|trendMonths/);
    expect(new URLSearchParams(href.split('?')[1]).get('eq_cf.k')).toBe('v');
    // 주변기기·이력으로는 옮길 수 없는 조건을 알려 준다
    const p = peripheralsHref(new URLSearchParams({ departmentId: 'd', state: 'IN_USE' }), { categoryId: 'c' });
    expect(p.href).toBe('/peripherals?departmentId=d&categoryId=c');
    expect(p.leftOut).toEqual(['state']);
    const h = historyHref(new URLSearchParams({ departmentId: 'd' }), 'ASSET', '2026-02-01');
    expect(h.href).toBe('/history/stock?kind=ASSET&from=2026-02-01&to=2026-02-28');
    expect(h.leftOut).toEqual(['departmentId']);
  });
});
