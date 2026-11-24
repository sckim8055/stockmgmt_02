// 5단계: 대시보드, 재고 이력, 감사 로그. 부서 범위, 구역별 권한, 기업 격리, 날짜 조건.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as assignRoute } from '@/app/api/assets/[id]/assign/route';
import { POST as assetsCreate } from '@/app/api/assets/route';
import { GET as dashboardRoute } from '@/app/api/dashboard/route';
import { GET as auditRoute } from '@/app/api/history/audit/route';
import { GET as stockHistoryRoute } from '@/app/api/history/stock/route';
import { POST as issueRoute } from '@/app/api/peripherals/issue/route';
import { POST as receiveRoute } from '@/app/api/peripherals/receive/route';
import { POST as thresholdCreate } from '@/app/api/thresholds/route';
import { closePool } from '@/lib/db/pool';
import { call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};
type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });
const post = (h: Handler, as: string, body: Record<string, unknown>) => call(h, { method: 'POST', cookie: cookie[as], body });
const get = (h: Handler, as: string, path = '/') => call(h, { cookie: cookie[as], path });

async function userWith(loginId: string, acl: [string, string][] | string, deptIds: string[] = []): Promise<void> {
  const o = await owner();
  const uid = await makeUser(A.id, loginId, 'COMPANY_USER');
  id[`user:${loginId}`] = uid;
  let roleId: string;
  if (typeof acl === 'string') roleId = (await o.query('SELECT id FROM app.role WHERE company_id = $1 AND name = $2', [A.id, acl])).rows[0].id;
  else {
    roleId = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [A.id, uniq('role')])).rows[0].id;
    for (const [r, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [roleId, r, op]);
  }
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [uid, roleId, A.id]);
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [uid, d, A.id]);
  cookie[loginId] = await sessionFor(A.code, loginId);
}

beforeAll(async () => {
  A = await makeCompany('RPTA');
  B = await makeCompany('RPTB');
  const o = await owner();
  const q = async (sql: string, p: unknown[]) => (await o.query(sql, p)).rows[0].id as string;
  id.it = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A.id])).rows[0].id;
  id.hr = await q("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [A.id]);
  const acat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [A.id]);
  const pcat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Mouse') RETURNING id", [A.id]);
  id.laptop = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Lenovo', 'X1') RETURNING id", [A.id, acat]);
  id.mouse = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'Logi', 'M1') RETURNING id", [A.id, pcat]);
  id.kim = await q("INSERT INTO app.person (company_id, name) VALUES ($1, 'Kim') RETURNING id", [A.id]);
  id.lee = await q("INSERT INTO app.person (company_id, name) VALUES ($1, 'Lee') RETURNING id", [A.id]);
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  await userWith('viewer', 'Viewer');
  await userWith('hrmanager', 'Stock Manager', [id.hr!]);
  await userWith('dashonly', [['dashboard', 'read']]);
  await userWith('assetdash', [['dashboard', 'read'], ['asset.item', 'read']]);
  await userWith('hraudit', [['history.audit', 'read'], ['history.stock', 'read']], [id.hr!]);
  await userWith('nothing', [['asset.item', 'read']]);

  // 자료: IT 자산 3대(1대 배정, 1대 대여·연체), HR 자산 1대(보증 곧 만료), HR 마우스 5개(2개 대여·연체), IT 마우스 4개
  const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const mk = async (over: Record<string, unknown>) => (await post(assetsCreate, 'admin', { modelId: id.laptop, assetTag: uniq('RP-'), purchasePrice: 4444444, supplier: 'HiddenVendor', ...over })).data.assetId as string;
  await mk({});
  id.assigned = await mk({});
  await call(withId(assignRoute, id.assigned), { method: 'POST', cookie: cookie.admin, body: { action: 'ASSIGN', holderPersonId: id.kim, note: 'it note' } });
  id.lent = await mk({});
  await call(withId(assignRoute, id.lent), { method: 'POST', cookie: cookie.admin, body: { action: 'LOAN', holderPersonId: id.lee, dueDate: day(10) } });
  await o.query('UPDATE app.asset SET due_date = current_date - 5 WHERE id = $1', [id.lent]);
  id.hrAsset = await mk({ departmentId: id.hr, warrantyEnd: day(7) });
  const hrStock = (await post(receiveRoute, 'admin', { modelId: id.mouse, departmentId: id.hr, qty: 5 })).data.stockId as string;
  const loan = (await post(issueRoute, 'admin', { action: 'LOAN', stockId: hrStock, personId: id.kim, qty: 2, dueDate: day(10) })).data.loanId;
  await o.query('UPDATE app.peripheral_loan SET due_date = current_date - 5 WHERE id = $1', [loan]);
  const itStock = (await post(receiveRoute, 'admin', { modelId: id.mouse, qty: 4 })).data.stockId as string;
  await post(issueRoute, 'admin', { action: 'ISSUE', stockId: itStock, personId: id.lee, qty: 1, note: 'it issue' });
  await post(thresholdCreate, 'admin', { modelId: id.mouse, minQty: 100 }); // 기업 전체, 부족
  await post(thresholdCreate, 'admin', { modelId: id.mouse, departmentId: id.hr, minQty: 1 }); // HR, 정상
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('대시보드', () => {
  it('관리자는 기업 전체 수치를 본다', async () => {
    const d = (await get(dashboardRoute, 'admin')).data;
    expect(d.scoped).toBe(false);
    expect(d.assets).toMatchObject({ total: 4, overdue: 1, warrantySoon: 1 });
    const state = (s: string, sub: string | null) => d.assets.byState.find((x: { state: string; substate: string | null }) => x.state === s && x.substate === sub)?.n ?? 0;
    expect(state('IN_STOCK', 'AVAILABLE')).toBe(2);
    expect(state('IN_USE', null)).toBe(2);
    expect(d.assets.byCategory).toEqual([expect.objectContaining({ name: 'Laptop', available: 2, in_use: 2, total: 4 })]);
    expect(d.peripherals).toEqual({ onHand: 6, onLoan: 2, stockRows: 2 });
    expect(d.loans).toEqual({ open: 1, overdue: 1 });
    expect(d.thresholds).toEqual({ active: 2, low: 1 });
    expect(JSON.stringify(d)).not.toMatch(/4444444|HiddenVendor|purchase|supplier/);
  });

  it('부서 범위가 제한되면 자기 부서의 수치만 센다', async () => {
    const d = (await get(dashboardRoute, 'hrmanager')).data;
    expect(d.scoped).toBe(true);
    expect(d.assets).toMatchObject({ total: 1, overdue: 0, warrantySoon: 1 });
    expect(d.peripherals).toEqual({ onHand: 3, onLoan: 2, stockRows: 1 });
    expect(d.loans).toEqual({ open: 1, overdue: 1 });
    expect(d.thresholds).toEqual({ active: 1, low: 0 }); // 기업 전체 한계 수량은 세지 않는다
  });

  it('구역마다 그 자료의 조회 권한이 있어야 채워진다', async () => {
    expect((await get(dashboardRoute, 'dashonly')).data).toMatchObject({ assets: null, peripherals: null, loans: null, thresholds: null });
    const partial = (await get(dashboardRoute, 'assetdash')).data;
    expect(partial.assets.total).toBe(4);
    expect(partial).toMatchObject({ peripherals: null, loans: null, thresholds: null });
    expect((await get(dashboardRoute, 'nothing')).status).toBe(403);
    expect((await call(dashboardRoute)).status).toBe(401);
    // 다른 기업은 0
    const b = (await get(dashboardRoute, 'badmin')).data;
    expect(b.assets.total).toBe(0);
    expect(b.peripherals.onHand).toBe(0);
  });
});

describe('재고 이력', () => {
  it('자산과 주변기기의 이력을 함께, 최근 것부터 보여 준다', async () => {
    const r = await get(stockHistoryRoute, 'admin', '/api/history/stock?pageSize=200');
    expect(r.status).toBe(200);
    const kinds = new Set(r.data.items.map((x: { kind: string }) => x.kind));
    expect([...kinds].sort()).toEqual(['ASSET', 'PERIPHERAL']);
    const times = r.data.items.map((x: { created_at: string }) => x.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    const assign = r.data.items.find((x: { type: string; ref_id: string }) => x.type === 'ASSIGN' && x.ref_id === id.assigned);
    expect(assign).toMatchObject({ kind: 'ASSET', to_person: 'Kim', to_state: 'IN_USE', department_name: 'IT', actor_name: 'Admin', note: 'it note' });
    const issue = r.data.items.find((x: { type: string }) => x.type === 'ISSUE');
    expect(issue).toMatchObject({ kind: 'PERIPHERAL', qty: -1, to_person: 'Lee', model_name: 'M1' });
    expect(JSON.stringify(r.data)).not.toMatch(/4444444|HiddenVendor/);
  });

  it('조건: 구분, 종류, 직원, 검색, 날짜, 페이지', async () => {
    const list = async (qs: string) => (await get(stockHistoryRoute, 'admin', `/api/history/stock?pageSize=200&${qs}`)).data.items as { kind: string; type: string; to_person: string | null }[];
    expect((await list('kind=PERIPHERAL')).every((x) => x.kind === 'PERIPHERAL')).toBe(true);
    expect((await list('type=LOAN')).map((x) => x.kind).sort()).toEqual(['ASSET', 'PERIPHERAL']);
    const lee = await list(`personId=${id.lee}`);
    expect(lee.length).toBe(2); // 자산 대여 1 + 주변기기 지급 1
    expect((await list('q=logi')).every((x) => x.kind === 'PERIPHERAL')).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    expect((await list(`from=${yesterday}&to=${tomorrow}`)).length).toBeGreaterThan(5);
    expect(await list(`from=${tomorrow}`)).toEqual([]);
    expect(await list(`to=${yesterday}`)).toEqual([]);
    expect(today).toMatch(/^\d{4}/);
    const p1 = await get(stockHistoryRoute, 'admin', '/api/history/stock?pageSize=3');
    expect(p1.data).toMatchObject({ page: 1, pageSize: 3, hasMore: true });
    expect(p1.data.items.length).toBe(3);
    const p2 = await get(stockHistoryRoute, 'admin', '/api/history/stock?pageSize=3&page=2');
    expect(p2.data.items.map((x: { id: string }) => x.id).some((v: string) => p1.data.items.map((x: { id: string }) => x.id).includes(v))).toBe(false);
    for (const bad of ['type=drop%20table', 'from=2024-02-30', 'kind=ALL', 'pageSize=1000', 'personId=1']) {
      expect((await get(stockHistoryRoute, 'admin', `/api/history/stock?${bad}`)).status, bad).toBe(400);
    }
  });

  it('부서 범위와 다른 기업, 권한', async () => {
    const hr = (await get(stockHistoryRoute, 'hrmanager', '/api/history/stock?pageSize=200')).data.items as { department_name: string; note: string | null }[];
    expect(hr.length).toBeGreaterThan(0);
    expect(hr.every((x) => x.department_name === 'HR')).toBe(true);
    expect(JSON.stringify(hr)).not.toMatch(/it note|it issue/);
    expect((await get(stockHistoryRoute, 'badmin', '/api/history/stock')).data.items).toEqual([]);
    expect((await get(stockHistoryRoute, 'nothing')).status).toBe(403);
    expect((await get(stockHistoryRoute, 'viewer')).status).toBe(200);
  });
});

describe('감사 로그', () => {
  it('기업의 관리 기록을 조건으로 찾는다', async () => {
    const r = await get(auditRoute, 'admin', '/api/history/audit?pageSize=200');
    expect(r.status).toBe(200);
    const actions = new Set(r.data.items.map((x: { action: string }) => x.action));
    expect(actions.has('ASSET_CREATED') || actions.has('THRESHOLD_CREATED')).toBe(true);
    const th = await get(auditRoute, 'admin', '/api/history/audit?action=THRESHOLD');
    expect(th.data.items.length).toBe(2);
    expect(th.data.items.every((x: { action: string; resource: string; actor_name: string }) => x.action.startsWith('THRESHOLD') && x.resource === 'threshold' && x.actor_name === 'Admin')).toBe(true);
    expect((await get(auditRoute, 'admin', '/api/history/audit?resource=threshold')).data.items.length).toBe(2);
    const byViewer = (await get(auditRoute, 'admin', `/api/history/audit?actorId=${id['user:viewer']}`)).data.items;
    expect(byViewer.every((x: { actor_id: string; action: string }) => x.actor_id === id['user:viewer'] && !x.action.startsWith('THRESHOLD'))).toBe(true);
    const target = th.data.items[0].target_id;
    expect((await get(auditRoute, 'admin', `/api/history/audit?targetId=${target}`)).data.items.length).toBe(1);
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    expect((await get(auditRoute, 'admin', `/api/history/audit?from=${tomorrow}`)).data.items).toEqual([]);
    const p = await get(auditRoute, 'admin', '/api/history/audit?pageSize=2');
    expect(p.data).toMatchObject({ hasMore: true });
    // LIKE 문자는 글자 그대로 취급된다.
    expect((await get(auditRoute, 'admin', '/api/history/audit?action=%25')).status).toBe(400);
    expect(JSON.stringify(r.data)).not.toMatch(/4444444|HiddenVendor|password_hash/);
  });

  it('부서 범위가 제한된 사용자, 다른 기업, 권한 없는 사용자는 볼 수 없다', async () => {
    expect((await get(auditRoute, 'hraudit')).status).toBe(403);
    expect((await get(auditRoute, 'viewer')).status).toBe(403);
    expect((await get(auditRoute, 'nothing')).status).toBe(403);
    const b = await get(auditRoute, 'badmin', '/api/history/audit?pageSize=200');
    expect(b.status).toBe(200);
    expect(b.data.items.every((x: { action: string }) => !x.action.startsWith('THRESHOLD') && !x.action.startsWith('ASSET'))).toBe(true);
    expect((await call(auditRoute)).status).toBe(401);
  });
});

describe('자기 화면 언어', () => {
  it('자기 언어만 바꿀 수 있고, 다른 항목은 받지 않는다', async () => {
    const { GET: meGet, PATCH: mePatch } = await import('@/app/api/me/route');
    const patch = (as: string, body: Record<string, unknown>) => call(mePatch as Handler, { method: 'PATCH', cookie: cookie[as], body });
    expect((await patch('viewer', { lang: 'zh' })).data).toEqual({ saved: true });
    expect((await call(meGet as Handler, { cookie: cookie.viewer })).data.user.lang).toBe('zh');
    const o = await owner();
    const others = (await o.query("SELECT count(*)::int AS n FROM app.app_user WHERE company_id = $1 AND lang = 'zh'", [A.id])).rows[0].n;
    expect(others).toBe(1);
    for (const body of [{ lang: 'fr' }, { lang: 'en', userType: 'COMPANY_ADMIN' }, { lang: 'en', displayName: 'x' }, {}]) {
      expect((await patch('viewer', body)).status).toBe(400);
    }
    expect((await call(mePatch as Handler, { method: 'PATCH', body: { lang: 'en' } })).status).toBe(401);
    // 요청 위조 방지: 다른 사이트에서 온 요청은 받지 않는다.
    expect((await call(mePatch as Handler, { method: 'PATCH', cookie: cookie.viewer, body: { lang: 'en' }, headers: { origin: 'http://evil.test' } })).status).toBe(403);
  });
});
