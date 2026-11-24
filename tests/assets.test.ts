// 2단계: 자산. 부서 범위, 제한 필드, 상태 전이, 기업 격리를 API 수준에서 확인한다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as assignRoute } from '@/app/api/assets/[id]/assign/route';
import { GET as historyRoute } from '@/app/api/assets/[id]/history/route';
import { POST as maintainRoute } from '@/app/api/assets/[id]/maintain/route';
import { POST as retireRoute } from '@/app/api/assets/[id]/retire/route';
import { GET as assetGet, PATCH as assetPatch } from '@/app/api/assets/[id]/route';
import { GET as assetsList, POST as assetsCreate } from '@/app/api/assets/route';
import { ACTION_RESOURCE, ASSET_ACTIONS } from '@/lib/assets/transitions';
import { closePool } from '@/lib/db/pool';
import { call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};

type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });
const one = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];

async function seedCompany(c: TestCompany, prefix: string): Promise<void> {
  const o = await owner();
  const q = async (sql: string, p: unknown[]) => (await o.query(sql, p)).rows[0].id as string;
  id[`${prefix}it`] = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [c.id])).rows[0].id;
  id[`${prefix}hr`] = await q("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [c.id]);
  const cat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [c.id]);
  const pcat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Mouse') RETURNING id", [c.id]);
  id[`${prefix}cat`] = cat;
  id[`${prefix}model`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Lenovo', 'X1') RETURNING id", [c.id, cat]);
  id[`${prefix}model2`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Dell', 'L5') RETURNING id", [c.id, cat]);
  id[`${prefix}pmodel`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'Logi', 'M1') RETURNING id", [c.id, pcat]);
  id[`${prefix}offmodel`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name, is_active) VALUES ($1, $2, 'ASSET', 'Old', 'Z', false) RETURNING id", [c.id, cat]);
  id[`${prefix}p1`] = await q("INSERT INTO app.person (company_id, employee_no, name) VALUES ($1, 'E1', 'Kim') RETURNING id", [c.id]);
  id[`${prefix}p2`] = await q("INSERT INTO app.person (company_id, employee_no, name) VALUES ($1, 'E2', 'Lee') RETURNING id", [c.id]);
  id[`${prefix}pgone`] = await q("INSERT INTO app.person (company_id, name, is_active) VALUES ($1, 'Gone', false) RETURNING id", [c.id]);
  await o.query("INSERT INTO app.custom_field_def (company_id, key, label, data_type, is_restricted) VALUES ($1, 'mac', 'MAC', 'text', false), ($1, 'cost_center', 'Cost center', 'text', true), ($1, 'seats', 'Seats', 'number', false)", [c.id]);
}

async function userWithRole(c: TestCompany, loginId: string, roleName: string, deptIds: string[] = []): Promise<void> {
  const o = await owner();
  const userId = await makeUser(c.id, loginId, 'COMPANY_USER');
  const role = (await o.query('SELECT id FROM app.role WHERE company_id = $1 AND name = $2', [c.id, roleName])).rows[0].id;
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [userId, role, c.id]);
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [userId, d, c.id]);
  cookie[loginId] = await sessionFor(c.code, loginId);
}

const tag = () => uniq('T-');
async function create(as: string, over: Record<string, unknown> = {}) {
  return call(assetsCreate, { method: 'POST', cookie: cookie[as], body: { modelId: id.model, assetTag: tag(), ...over } });
}
const act = (route: Handler, as: string, assetId: string, body: Record<string, unknown>) =>
  call(withId(route, assetId), { method: 'POST', cookie: cookie[as], body });
const stateOf = async (assetId: string) => {
  const r = await one('SELECT state, substate, holder_person_id, due_date::text AS due FROM app.asset WHERE id = $1', [assetId]);
  return `${r.state}/${r.substate ?? '-'}`;
};

beforeAll(async () => {
  A = await makeCompany('ASTA');
  B = await makeCompany('ASTB');
  await seedCompany(A, '');
  await seedCompany(B, 'b');
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  await userWithRole(A, 'viewer', 'Viewer');
  await userWithRole(A, 'oper', 'Stock Operator'); // 제한 필드 권한 없음, 폐기 권한 없음
  await userWithRole(A, 'manager', 'Stock Manager'); // 제한 필드 포함 전부
  await userWithRole(A, 'hroper', 'Stock Operator', [id.hr!]); // 부서 범위: HR
  await userWithRole(A, 'hrmanager', 'Stock Manager', [id.hr!]);
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('제한 필드', () => {
  let assetId: string;
  beforeAll(async () => {
    const r = await create('admin', { purchasePrice: 1234567, supplier: 'SecretVendor', custom: { mac: 'aa:bb', cost_center: 'CC-9', seats: 3 } });
    expect(r.status).toBe(201);
    assetId = r.data.assetId;
  });

  it('권한이 있으면 보이고, 없으면 응답에 키 자체가 없다(상세·목록 모두)', async () => {
    const full = (await call(withId(assetGet, assetId), { cookie: cookie.manager })).data.asset;
    expect(full).toMatchObject({ purchase_price: 1234567, supplier: 'SecretVendor', custom: { mac: 'aa:bb', cost_center: 'CC-9', seats: 3 } });
    for (const who of ['oper', 'viewer']) {
      const limited = (await call(withId(assetGet, assetId), { cookie: cookie[who] })).data.asset;
      expect('purchase_price' in limited, who).toBe(false);
      expect('supplier' in limited, who).toBe(false);
      expect(limited.custom).toEqual({ mac: 'aa:bb', seats: 3 });
      const list = await call(assetsList, { cookie: cookie[who], path: '/api/assets?pageSize=200' });
      expect(JSON.stringify(list.data)).not.toMatch(/SecretVendor|1234567|CC-9|purchase_price|supplier|cost_center/);
    }
  });

  it('읽을 수 없는 필드로는 정렬할 수 없고, 제한 필드는 검색 대상이 아니다', async () => {
    expect((await call(assetsList, { cookie: cookie.oper, path: '/api/assets?sort=purchase_price' })).status).toBe(403);
    expect((await call(assetsList, { cookie: cookie.manager, path: '/api/assets?sort=purchase_price&order=desc' })).status).toBe(200);
    expect((await call(assetsList, { cookie: cookie.oper, path: '/api/assets?q=SecretVendor' })).data.total).toBe(0);
    expect((await call(assetsList, { cookie: cookie.manager, path: '/api/assets?q=SecretVendor' })).data.total).toBe(0);
    expect((await call(assetsList, { cookie: cookie.oper, path: '/api/assets?sort=nope' })).status).toBe(400);
  });

  it('쓰기 권한이 없으면 제한 필드를 입력·수정할 수 없고, 값은 그대로다', async () => {
    expect((await create('oper', { purchasePrice: 1 })).status).toBe(403);
    expect((await create('oper', { supplier: 'x' })).status).toBe(403);
    expect((await create('oper', { custom: { cost_center: 'x' } })).status).toBe(403);
    expect((await call(withId(assetPatch, assetId), { method: 'PATCH', cookie: cookie.oper, body: { supplier: 'Changed' } })).status).toBe(403);
    expect((await call(withId(assetPatch, assetId), { method: 'PATCH', cookie: cookie.oper, body: { purchasePrice: null } })).status).toBe(403);
    expect((await call(withId(assetPatch, assetId), { method: 'PATCH', cookie: cookie.oper, body: { custom: { cost_center: null } } })).status).toBe(403);
    // 제한되지 않은 필드는 고칠 수 있고, 그때 제한 필드는 지워지지 않는다.
    expect((await call(withId(assetPatch, assetId), { method: 'PATCH', cookie: cookie.oper, body: { location: 'Seoul 3F', custom: { mac: 'cc:dd' } } })).status).toBe(200);
    const row = await one('SELECT supplier, purchase_price::float8 AS price, custom FROM app.asset WHERE id = $1', [assetId]);
    expect(row).toEqual({ supplier: 'SecretVendor', price: 1234567, custom: { mac: 'cc:dd', cost_center: 'CC-9', seats: 3 } });
  });

  it('사용자 지정 필드: 정의되지 않은 키와 형식이 틀린 값은 거부된다', async () => {
    expect((await create('admin', { custom: { nope: 'x' } })).status).toBe(400);
    expect((await create('admin', { custom: { seats: 'three' } })).status).toBe(400);
    expect((await create('admin', { custom: { mac: 12 } })).status).toBe(400);
  });

  it('감사 로그와 이력에는 제한 필드의 값이 남지 않는다', async () => {
    await call(withId(assetPatch, assetId), { method: 'PATCH', cookie: cookie.admin, body: { purchasePrice: 7654321, supplier: 'OtherSecret' } });
    const o = await owner();
    const audit = await o.query("SELECT coalesce(before::text, '') || coalesce(after::text, '') AS t FROM app.audit_log WHERE target_id = $1", [assetId]);
    const txn = await o.query("SELECT coalesce(note, '') AS t FROM app.asset_txn WHERE asset_id = $1", [assetId]);
    for (const r of [...audit.rows, ...txn.rows]) expect(r.t).not.toMatch(/7654321|1234567|OtherSecret|SecretVendor|CC-9/);
    expect(audit.rows.length).toBeGreaterThan(1);
  });

  it('수정 API로는 상태·보유자를 바꿀 수 없다', async () => {
    for (const body of [{ state: 'RETIRED' }, { holderPersonId: id.p1 }, { holder_person_id: id.p1 }, { substate: 'DISPOSED' }, { companyId: B.id }]) {
      expect((await call(withId(assetPatch, assetId), { method: 'PATCH', cookie: cookie.admin, body })).status).toBe(400);
    }
    expect(await stateOf(assetId)).toBe('IN_STOCK/AVAILABLE');
  });
});

describe('부서 범위', () => {
  let itAsset: string;
  let hrAsset: string;
  beforeAll(async () => {
    itAsset = (await create('admin', { departmentId: id.it })).data.assetId;
    hrAsset = (await create('admin', { departmentId: id.hr })).data.assetId;
  });

  it('범위 밖 자산은 목록·건수에 없고, ID로 지정해도 없는 것으로 응답한다', async () => {
    const list = await call(assetsList, { cookie: cookie.hroper, path: '/api/assets?pageSize=200' });
    const ids = list.data.items.map((a: { id: string }) => a.id);
    expect(ids).toContain(hrAsset);
    expect(ids).not.toContain(itAsset);
    expect(list.data.items.every((a: { department_id: string }) => a.department_id === id.hr)).toBe(true);
    expect(list.data.total).toBe(list.data.items.length);
    const all = await call(assetsList, { cookie: cookie.admin, path: '/api/assets?pageSize=200' });
    expect(all.data.total).toBeGreaterThan(list.data.total);
    // 필터로 범위 밖 부서를 지정해도 나오지 않는다.
    expect((await call(assetsList, { cookie: cookie.hroper, path: `/api/assets?departmentId=${id.it}` })).data.total).toBe(0);

    expect((await call(withId(assetGet, itAsset), { cookie: cookie.hroper })).status).toBe(404);
    expect((await call(withId(assetPatch, itAsset), { method: 'PATCH', cookie: cookie.hroper, body: { location: 'x' } })).status).toBe(404);
    expect((await act(assignRoute, 'hroper', itAsset, { action: 'ASSIGN', holderPersonId: id.p1 })).status).toBe(404);
    expect((await act(maintainRoute, 'hroper', itAsset, { action: 'RESERVE' })).status).toBe(404);
    expect((await act(retireRoute, 'hrmanager', itAsset, { action: 'RETIRE' })).status).toBe(404);
    expect((await call(withId(historyRoute, itAsset), { cookie: cookie.hroper })).status).toBe(404);
    expect(await stateOf(itAsset)).toBe('IN_STOCK/AVAILABLE');
    expect((await one('SELECT location FROM app.asset WHERE id = $1', [itAsset])).location).toBeNull();
  });

  it('범위가 제한된 사용자는 자기 범위 안에만 등록할 수 있다', async () => {
    expect((await create('hroper')).status).toBe(400); // 기본 부서(IT)는 범위 밖 → 부서를 지정해야 한다
    expect((await create('hroper', { departmentId: id.it })).status).toBe(403);
    const ok = await create('hroper', { departmentId: id.hr });
    expect(ok.status).toBe(201);
    expect((await one('SELECT department_id FROM app.asset WHERE id = $1', [ok.data.assetId])).department_id).toBe(id.hr);
    // 범위 제한이 없으면 부서를 생략할 때 IT로 들어간다.
    const def = await create('oper');
    expect((await one('SELECT department_id FROM app.asset WHERE id = $1', [def.data.assetId])).department_id).toBe(id.it);
  });

  it('관리 부서 변경은 범위 제한이 없는 사용자만 할 수 있다', async () => {
    expect((await call(withId(assetPatch, hrAsset), { method: 'PATCH', cookie: cookie.hrmanager, body: { departmentId: id.it } })).status).toBe(403);
    expect((await one('SELECT department_id FROM app.asset WHERE id = $1', [hrAsset])).department_id).toBe(id.hr);
    // 관리자가 IT 자산을 HR로 옮기면 그때부터 HR 담당에게 보인다.
    expect((await call(withId(assetPatch, itAsset), { method: 'PATCH', cookie: cookie.admin, body: { departmentId: id.hr } })).status).toBe(200);
    expect((await call(withId(assetGet, itAsset), { cookie: cookie.hroper })).status).toBe(200);
    const txn = await one("SELECT from_department_id, to_department_id FROM app.asset_txn WHERE asset_id = $1 AND type = 'CHANGE_DEPARTMENT'", [itAsset]);
    expect(txn).toEqual({ from_department_id: id.it, to_department_id: id.hr });
  });
});

describe('다른 기업', () => {
  it('B 계정은 A의 자산을 ID로 지정해도 찾을 수 없고, A는 B의 모델·부서·직원을 쓸 수 없다', async () => {
    const assetId = (await create('admin')).data.assetId;
    expect((await call(withId(assetGet, assetId), { cookie: cookie.badmin })).status).toBe(404);
    expect((await call(withId(assetPatch, assetId), { method: 'PATCH', cookie: cookie.badmin, body: { location: 'x' } })).status).toBe(404);
    expect((await call(withId(assignRoute, assetId), { method: 'POST', cookie: cookie.badmin, body: { action: 'ASSIGN', holderPersonId: id.bp1 } })).status).toBe(404);
    expect((await call(withId(historyRoute, assetId), { cookie: cookie.badmin })).status).toBe(404);
    expect((await call(assetsList, { cookie: cookie.badmin, path: '/api/assets?pageSize=200' })).data.items.map((a: { id: string }) => a.id)).not.toContain(assetId);

    expect((await create('admin', { modelId: id.bmodel })).status).toBe(400);
    expect((await create('admin', { departmentId: id.bit })).status).toBe(400);
    expect((await act(assignRoute, 'admin', assetId, { action: 'ASSIGN', holderPersonId: id.bp1 })).status).toBe(400);
    expect((await call(withId(assetPatch, assetId), { method: 'PATCH', cookie: cookie.admin, body: { modelId: id.bmodel } })).status).toBe(400);
    expect(await stateOf(assetId)).toBe('IN_STOCK/AVAILABLE');
  });
});

describe('등록 규칙', () => {
  it('주변기기용 모델, 비활성 모델로는 자산을 등록할 수 없다', async () => {
    expect((await create('admin', { modelId: id.pmodel })).status).toBe(400);
    expect((await create('admin', { modelId: id.offmodel })).status).toBe(400);
  });

  it('자산 태그는 기업 안에서 고유하고(대소문자 무시), 등록 취소된 자산의 태그도 다시 쓸 수 없다', async () => {
    const t = tag();
    const first = await create('admin', { assetTag: t });
    expect(first.status).toBe(201);
    expect((await create('admin', { assetTag: t.toLowerCase() })).status).toBe(409);
    expect((await act(retireRoute, 'admin', first.data.assetId, { action: 'VOID' })).status).toBe(200);
    expect((await create('admin', { assetTag: t })).status).toBe(409);
    // 다른 기업에서는 같은 태그를 쓸 수 있다.
    expect((await call(assetsCreate, { method: 'POST', cookie: cookie.badmin, body: { modelId: id.bmodel, assetTag: t } })).status).toBe(201);
  });

  it('시리얼 번호는 같은 모델 안에서만 고유하다', async () => {
    const sn = uniq('SN');
    expect((await create('admin', { serialNumber: sn })).status).toBe(201);
    expect((await create('admin', { serialNumber: sn.toLowerCase() })).status).toBe(409);
    expect((await create('admin', { serialNumber: sn, modelId: id.model2 })).status).toBe(201);
  });

  it('같은 태그를 동시에 등록해도 하나만 만들어지고 500이 나지 않는다', async () => {
    const t = tag();
    const results = await Promise.all(Array.from({ length: 4 }, () => create('admin', { assetTag: t })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });

  it('권한이 없으면 등록·수정할 수 없다', async () => {
    expect((await create('viewer')).status).toBe(403);
    const assetId = (await create('admin')).data.assetId;
    expect((await call(withId(assetPatch, assetId), { method: 'PATCH', cookie: cookie.viewer, body: { location: 'x' } })).status).toBe(403);
    expect((await call(assetsList)).status).toBe(401);
  });
});

describe('상태 전이', () => {
  it('정상 수명 주기: 배정 → 반납 → 대여 → 불량 반납 → 수리 → 분실 → 발견 → 퇴역 → 처분', async () => {
    const a = (await create('admin')).data.assetId;
    const step = async (route: Handler, body: Record<string, unknown>, expectStatus: number, expectState: string) => {
      const r = await act(route, 'admin', a, body);
      expect(r.status, JSON.stringify(body)).toBe(expectStatus);
      expect(await stateOf(a), JSON.stringify(body)).toBe(expectState);
    };
    await step(assignRoute, { action: 'ASSIGN' }, 409, 'IN_STOCK/AVAILABLE'); // 받는 사람 없음
    await step(assignRoute, { action: 'ASSIGN', holderPersonId: id.p1, location: 'Desk 12' }, 200, 'IN_USE/-');
    await step(assignRoute, { action: 'ASSIGN', holderPersonId: id.p2 }, 409, 'IN_USE/-'); // 이미 사용 중
    await step(retireRoute, { action: 'RETIRE' }, 409, 'IN_USE/-'); // 사용 중에는 퇴역 불가
    await step(retireRoute, { action: 'VOID' }, 409, 'IN_USE/-');
    await step(assignRoute, { action: 'RETURN' }, 200, 'IN_STOCK/AVAILABLE');
    expect((await one('SELECT holder_person_id FROM app.asset WHERE id = $1', [a])).holder_person_id).toBeNull();
    await step(assignRoute, { action: 'LOAN', holderPersonId: id.p2 }, 409, 'IN_STOCK/AVAILABLE'); // 반납 기한 없음
    await step(assignRoute, { action: 'LOAN', holderPersonId: id.p2, dueDate: '2027-01-31' }, 200, 'IN_USE/-');
    expect((await one('SELECT due_date::text AS d FROM app.asset WHERE id = $1', [a])).d).toBe('2027-01-31');
    await step(assignRoute, { action: 'RETURN', defective: true }, 200, 'IN_STOCK/DEFECTIVE');
    expect((await one('SELECT due_date FROM app.asset WHERE id = $1', [a])).due_date).toBeNull();
    await step(assignRoute, { action: 'ASSIGN', holderPersonId: id.p1 }, 409, 'IN_STOCK/DEFECTIVE'); // 불량은 배정 불가
    await step(maintainRoute, { action: 'REPAIR_IN' }, 200, 'MAINTENANCE/-');
    await step(maintainRoute, { action: 'REPAIR_OUT' }, 200, 'IN_STOCK/AVAILABLE');
    await step(maintainRoute, { action: 'RESERVE' }, 200, 'IN_STOCK/RESERVED');
    await step(maintainRoute, { action: 'UNRESERVE' }, 200, 'IN_STOCK/AVAILABLE');
    await step(retireRoute, { action: 'MARK_MISSING' }, 200, 'MISSING/-');
    await step(retireRoute, { action: 'FOUND' }, 200, 'IN_STOCK/AVAILABLE');
    await step(retireRoute, { action: 'DISPOSE', disposal: 'SOLD' }, 409, 'IN_STOCK/AVAILABLE'); // 퇴역 전에는 처분 불가
    await step(retireRoute, { action: 'RETIRE' }, 200, 'RETIRED/PENDING_DISPOSAL');
    await step(retireRoute, { action: 'DISPOSE' }, 409, 'RETIRED/PENDING_DISPOSAL'); // 처분 방식 없음
    await step(retireRoute, { action: 'DISPOSE', disposal: 'SOLD' }, 200, 'RETIRED/SOLD');
    // 처분된 자산은 어떤 처리도 받지 않는다.
    await step(assignRoute, { action: 'ASSIGN', holderPersonId: id.p1 }, 409, 'RETIRED/SOLD');
    await step(retireRoute, { action: 'FOUND' }, 409, 'RETIRED/SOLD');
    await step(maintainRoute, { action: 'REPAIR_IN' }, 409, 'RETIRED/SOLD');

    // 이력: 성공한 처리마다 한 줄씩, 실패한 처리는 남지 않는다.
    const h = await call(withId(historyRoute, a), { cookie: cookie.admin });
    const types = h.data.history.map((x: { type: string }) => x.type).reverse();
    expect(types).toEqual(['REGISTER', 'ASSIGN', 'RETURN', 'LOAN', 'RETURN', 'REPAIR_IN', 'REPAIR_OUT', 'RESERVE', 'UNRESERVE', 'MARK_MISSING', 'FOUND', 'RETIRE', 'DISPOSE']);
    const firstAssign = h.data.history.find((x: { type: string }) => x.type === 'ASSIGN');
    expect(firstAssign).toMatchObject({ to_holder_name: 'Kim', to_location: 'Desk 12', from_state: 'IN_STOCK', to_state: 'IN_USE', actor_name: 'Admin' });
  });

  it('입고 예정 → 입고 확정, 그리고 등록 취소', async () => {
    const a = (await create('admin', { initialState: 'ON_ORDER' })).data.assetId;
    expect(await stateOf(a)).toBe('ON_ORDER/-');
    expect((await act(assignRoute, 'admin', a, { action: 'ASSIGN', holderPersonId: id.p1 })).status).toBe(409);
    expect((await act(maintainRoute, 'admin', a, { action: 'RECEIVE' })).status).toBe(200);
    expect(await stateOf(a)).toBe('IN_STOCK/AVAILABLE');
    expect((await act(retireRoute, 'admin', a, { action: 'VOID' })).status).toBe(200);
    expect(await stateOf(a)).toBe('VOID/-');
    expect((await call(withId(assetPatch, a), { method: 'PATCH', cookie: cookie.admin, body: { location: 'x' } })).status).toBe(409);
    // 등록 취소된 자산은 기본 목록에 없고, 따로 요청하면 보인다.
    const ids = async (path: string) => (await call(assetsList, { cookie: cookie.admin, path })).data.items.map((x: { id: string }) => x.id);
    expect(await ids('/api/assets?pageSize=200')).not.toContain(a);
    expect(await ids('/api/assets?pageSize=200&includeVoid=true&state=VOID')).toContain(a);
  });

  it('사용 중 자산을 수리 보내면 보유자가 유지되고, 수리가 끝나면 그 사람에게 돌아간다', async () => {
    const a = (await create('admin')).data.assetId;
    await act(assignRoute, 'admin', a, { action: 'ASSIGN', holderPersonId: id.p1 });
    expect((await act(maintainRoute, 'admin', a, { action: 'REPAIR_IN' })).status).toBe(200);
    expect((await one('SELECT state, holder_person_id FROM app.asset WHERE id = $1', [a]))).toEqual({ state: 'MAINTENANCE', holder_person_id: id.p1 });
    expect((await act(maintainRoute, 'admin', a, { action: 'REPAIR_OUT' })).status).toBe(200);
    expect((await one('SELECT state, holder_person_id FROM app.asset WHERE id = $1', [a]))).toEqual({ state: 'IN_USE', holder_person_id: id.p1 });
  });

  it('비활성 직원에게는 배정할 수 없다', async () => {
    const a = (await create('admin')).data.assetId;
    expect((await act(assignRoute, 'admin', a, { action: 'ASSIGN', holderPersonId: id.pgone })).status).toBe(400);
    expect(await stateOf(a)).toBe('IN_STOCK/AVAILABLE');
  });

  it('같은 자산을 동시에 두 사람에게 배정하면 한 건만 성공한다', async () => {
    const a = (await create('admin')).data.assetId;
    const results = await Promise.all([
      act(assignRoute, 'admin', a, { action: 'ASSIGN', holderPersonId: id.p1 }),
      act(assignRoute, 'oper', a, { action: 'ASSIGN', holderPersonId: id.p2 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await one("SELECT count(*)::int AS n FROM app.asset_txn WHERE asset_id = $1 AND type = 'ASSIGN'", [a])).n).toBe(1);
  });
});

describe('처리 권한', () => {
  it('처리마다 필요한 권한이 다르고, 다른 권한의 라우트로 우회할 수 없다', async () => {
    const a = (await create('admin')).data.assetId;
    // 재고 담당: 배정·수리는 되고 폐기·분실은 안 된다.
    expect((await act(retireRoute, 'oper', a, { action: 'RETIRE' })).status).toBe(403);
    expect((await act(retireRoute, 'oper', a, { action: 'VOID' })).status).toBe(403);
    // 배정 라우트에 폐기 처리를 실어 보내도 받지 않는다.
    expect((await act(assignRoute, 'oper', a, { action: 'RETIRE' })).status).toBe(400);
    expect((await act(maintainRoute, 'oper', a, { action: 'VOID' })).status).toBe(400);
    expect((await act(assignRoute, 'viewer', a, { action: 'ASSIGN', holderPersonId: id.p1 })).status).toBe(403);
    expect(await stateOf(a)).toBe('IN_STOCK/AVAILABLE');
    expect((await act(maintainRoute, 'oper', a, { action: 'RESERVE' })).status).toBe(200);
  });

  it('모든 처리는 자기 권한 리소스의 라우트에서만 받는다', async () => {
    const routes = { 'asset.assign': assignRoute, 'asset.maintain': maintainRoute, 'asset.retire': retireRoute } as const;
    const a = (await create('admin')).data.assetId;
    for (const action of ASSET_ACTIONS) {
      for (const [resource, route] of Object.entries(routes)) {
        const r = await act(route, 'admin', a, { action });
        // 자기 라우트: 형식 검사는 통과(200 또는 전이 규칙에 따른 409). 남의 라우트: 형식 검사에서 400.
        if (ACTION_RESOURCE[action] === resource) expect(r.status, `${action}@${resource}`).not.toBe(400);
        else expect(r.status, `${action}@${resource}`).toBe(400);
      }
    }
  });
});

describe('기준 정보와의 경합', () => {
  it('배정과 퇴사 처리가 동시에 와도, 퇴사한 직원이 자산을 보유하는 일은 없다', async () => {
    const { POST: deactivatePerson } = await import('@/app/api/master/persons/[id]/deactivate/route');
    const o = await owner();
    for (let i = 0; i < 12; i++) {
      const personId = (await o.query("INSERT INTO app.person (company_id, name) VALUES ($1, $2) RETURNING id", [A.id, uniq('Race')])).rows[0].id as string;
      const a = (await create('admin')).data.assetId;
      const calls = [
        act(assignRoute, 'admin', a, { action: 'ASSIGN', holderPersonId: personId }),
        call(withId(deactivatePerson as Handler, personId), { method: 'POST', cookie: cookie.admin }),
      ];
      const [assign, deactivate] = await Promise.all(i % 2 ? calls.reverse() : calls).then((r) => (i % 2 ? r.reverse() : r));
      const row = await one(
        'SELECT p.is_active, (SELECT count(*)::int FROM app.asset WHERE holder_person_id = p.id) AS held FROM app.person p WHERE p.id = $1',
        [personId],
      );
      expect(row.is_active === false && row.held > 0, `i=${i} assign=${assign!.status} deactivate=${deactivate!.status}`).toBe(false);
      expect([assign!.status, deactivate!.status].sort(), `i=${i}`).toEqual(expect.arrayContaining([200]));
      expect([200, 400]).toContain(assign!.status);
      expect([200, 409]).toContain(deactivate!.status);
    }
  });
});
