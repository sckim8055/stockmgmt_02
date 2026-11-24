// 4단계: 한계 수량, 알림. 상태 전환 시에만 알림, 받는 사람(권한·부서 범위), 격리, 중복 방지.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as alertsRead } from '@/app/api/alerts/read/route';
import { GET as alertsList } from '@/app/api/alerts/route';
import { POST as assignRoute } from '@/app/api/assets/[id]/assign/route';
import { GET as assetsList, POST as assetsCreate } from '@/app/api/assets/route';
import { POST as adjustRoute } from '@/app/api/peripherals/adjust/route';
import { POST as issueRoute } from '@/app/api/peripherals/issue/route';
import { POST as receiveRoute } from '@/app/api/peripherals/receive/route';
import { DELETE as thresholdDelete, PATCH as thresholdPatch } from '@/app/api/thresholds/[id]/route';
import { GET as thresholdsList, POST as thresholdCreate } from '@/app/api/thresholds/route';
import { runDailyAlerts } from '@/lib/alerts/daily';
import { withTenant } from '@/lib/db/context';
import { closePool } from '@/lib/db/pool';
import { call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};
const userId: Record<string, string> = {};

type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });
const one = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];
const post = (h: Handler, as: string, body: Record<string, unknown>) => call(h, { method: 'POST', cookie: cookie[as], body });
/** 그 사람이 받은 알림(오래된 것부터) */
const inbox = async (who: string) =>
  (await (await owner()).query('SELECT type, payload FROM app.notification WHERE user_id = $1 ORDER BY created_at, id', [userId[who]])).rows as { type: string; payload: Record<string, unknown> }[];
const typesFor = async (who: string, thresholdId: string) => (await inbox(who)).filter((n) => n.payload.thresholdId === thresholdId).map((n) => n.type);

async function userWith(loginId: string, acl: [string, string][] | string, deptIds: string[] = [], company = A): Promise<void> {
  const o = await owner();
  const uid = await makeUser(company.id, loginId, 'COMPANY_USER');
  userId[loginId] = uid;
  let roleId: string;
  if (typeof acl === 'string') roleId = (await o.query('SELECT id FROM app.role WHERE company_id = $1 AND name = $2', [company.id, acl])).rows[0].id;
  else {
    roleId = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [company.id, uniq('role')])).rows[0].id;
    for (const [r, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [roleId, r, op]);
  }
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [uid, roleId, company.id]);
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [uid, d, company.id]);
  cookie[loginId] = await sessionFor(company.code, loginId);
}

async function newModel(kind: 'ASSET' | 'PERIPHERAL'): Promise<string> {
  const o = await owner();
  return (await o.query('INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, $3, $4, $5) RETURNING id', [A.id, kind === 'ASSET' ? id.acat : id.pcat, kind, 'T', uniq('M')])).rows[0].id;
}

beforeAll(async () => {
  A = await makeCompany('ALRA');
  B = await makeCompany('ALRB');
  const o = await owner();
  const q = async (sql: string, p: unknown[]) => (await o.query(sql, p)).rows[0].id as string;
  id.it = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A.id])).rows[0].id;
  id.hr = await q("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [A.id]);
  id.acat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [A.id]);
  id.pcat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Mouse') RETURNING id", [A.id]);
  id.p1 = await q("INSERT INTO app.person (company_id, name) VALUES ($1, 'Kim') RETURNING id", [A.id]);
  id.bcat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Mouse') RETURNING id", [B.id]);
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  userId.admin = (await one("SELECT id FROM app.app_user WHERE company_id = $1 AND login_id = 'admin'", [A.id])).id;
  userId.badmin = (await one("SELECT id FROM app.app_user WHERE company_id = $1 AND login_id = 'admin'", [B.id])).id;
  await userWith('manager', 'Stock Manager'); // 알림함·한계 수량 권한 있음, 범위 제한 없음
  await userWith('hrmanager', 'Stock Manager', [id.hr!]);
  await userWith('noinbox', [['peripheral.stock', 'read'], ['peripheral.issue', 'execute']]); // 알림함 권한 없음
  await userWith('inactive', 'Stock Manager');
  await o.query('UPDATE app.app_user SET is_active = false WHERE id = $1', [userId.inactive]);
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('한계 수량: 주변기기', () => {
  it('수량이 한계 미만으로 내려갈 때 한 번, 여유 비율 이상으로 돌아올 때 한 번 알린다', async () => {
    const model = await newModel('PERIPHERAL');
    const stock = (await post(receiveRoute, 'admin', { modelId: model, qty: 10 })).data.stockId as string;
    const created = await post(thresholdCreate, 'admin', { modelId: model, minQty: 5, warnRatio: 1.5 });
    expect(created.status).toBe(201);
    const t = created.data.thresholdId as string;
    expect(await typesFor('admin', t)).toEqual([]);

    const issue = (n: number) => post(issueRoute, 'admin', { action: 'ISSUE', stockId: stock, personId: id.p1, qty: n });
    await issue(5); // 5 = 한계와 같음 → 아직 정상
    expect(await typesFor('admin', t)).toEqual([]);
    await issue(1); // 4 → 부족
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK']);
    await issue(1); // 3 → 이미 부족, 다시 알리지 않는다
    await post(receiveRoute, 'admin', { modelId: model, qty: 3 }); // 6 → 한계는 넘었지만 회복 기준(8) 미만
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK']);
    expect((await one('SELECT state FROM app.stock_threshold WHERE id = $1', [t])).state).toBe('LOW');
    await post(receiveRoute, 'admin', { modelId: model, qty: 2 }); // 8 → 회복
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK', 'STOCK_RECOVERED']);
    await post(adjustRoute, 'admin', { action: 'ADJUST', stockId: stock, countedQty: 0, note: '실사' }); // 조정으로도 판정된다
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK', 'STOCK_RECOVERED', 'LOW_STOCK']);

    const last = (await inbox('admin')).filter((n) => n.payload.thresholdId === t).at(-1)!;
    expect(last.payload).toMatchObject({ qty: 0, minQty: 5, department: null });
    const row = (await call(thresholdsList, { cookie: cookie.admin })).data.thresholds.find((x: { id: string }) => x.id === t);
    expect(row).toMatchObject({ state: 'LOW', qty: 0, min_qty: 5, warn_ratio: 1.5, kind: 'PERIPHERAL' });
  });

  it('만들 때 이미 부족하면 바로 알리고, 꺼 두면 알리지 않으며, 다시 켜면 새로 판정한다', async () => {
    const model = await newModel('PERIPHERAL');
    const stock = (await post(receiveRoute, 'admin', { modelId: model, qty: 1 })).data.stockId as string;
    const t = (await post(thresholdCreate, 'admin', { modelId: model, minQty: 3 })).data.thresholdId as string;
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK']);
    expect((await call(withId(thresholdPatch, t), { method: 'PATCH', cookie: cookie.admin, body: { isActive: false } })).status).toBe(200);
    await post(receiveRoute, 'admin', { modelId: model, qty: 10 });
    await post(issueRoute, 'admin', { action: 'ISSUE', stockId: stock, personId: id.p1, qty: 11 });
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK']);
    expect((await call(withId(thresholdPatch, t), { method: 'PATCH', cookie: cookie.admin, body: { isActive: true } })).status).toBe(200);
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK', 'LOW_STOCK']);
    // 한계를 낮추면 회복으로 판정된다.
    await call(withId(thresholdPatch, t), { method: 'PATCH', cookie: cookie.admin, body: { minQty: 0 } });
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK', 'LOW_STOCK', 'STOCK_RECOVERED']);
  });

  it('동시에 지급해도 부족 알림은 정확히 한 번 만들어진다', async () => {
    for (let round = 0; round < 5; round++) {
      const model = await newModel('PERIPHERAL');
      const stock = (await post(receiveRoute, 'admin', { modelId: model, qty: 6 })).data.stockId as string;
      const t = (await post(thresholdCreate, 'admin', { modelId: model, minQty: 5 })).data.thresholdId as string;
      // 6 → 5 → 4: 둘 다 끝나면 4 로 부족. 각자 자기 변경만 보면 둘 다 5 로 보고 알림을 놓친다.
      const results = await Promise.all([1, 1].map((n) => post(issueRoute, 'admin', { action: 'ISSUE', stockId: stock, personId: id.p1, qty: n })));
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(await typesFor('admin', t), `round ${round}`).toEqual(['LOW_STOCK']);
    }
  });
});

describe('한계 수량: 자산', () => {
  it('사용 가능한 재고 대수로 판정한다(배정하면 줄고, 반납하면 는다). 카테고리 단위와 부서 단위도 된다', async () => {
    const model = await newModel('ASSET');
    const byModel = (await post(thresholdCreate, 'admin', { modelId: model, minQty: 2 })).data.thresholdId as string;
    expect(await typesFor('admin', byModel)).toEqual(['LOW_STOCK']); // 0대
    const mk = async (departmentId?: string) => (await post(assetsCreate, 'admin', { modelId: model, assetTag: uniq('AL-'), ...(departmentId ? { departmentId } : {}) })).data.assetId as string;
    const a1 = await mk();
    await mk();
    expect(await typesFor('admin', byModel)).toEqual(['LOW_STOCK', 'STOCK_RECOVERED']);
    const hrOnly = (await post(thresholdCreate, 'admin', { modelId: model, departmentId: id.hr, minQty: 1 })).data.thresholdId as string;
    expect(await typesFor('admin', hrOnly)).toEqual(['LOW_STOCK']); // HR 에는 0대
    await mk(id.hr);
    expect(await typesFor('admin', hrOnly)).toEqual(['LOW_STOCK', 'STOCK_RECOVERED']);

    expect((await call(withId(assignRoute, a1), { method: 'POST', cookie: cookie.admin, body: { action: 'ASSIGN', holderPersonId: id.p1 } })).status).toBe(200);
    await call(withId(assignRoute, a1), { method: 'POST', cookie: cookie.admin, body: { action: 'RETURN', defective: true } }); // 불량은 사용 가능이 아니다
    // 전사: IT 1대 + HR 1대 = 2대 → 정상 유지
    expect(await typesFor('admin', byModel)).toEqual(['LOW_STOCK', 'STOCK_RECOVERED']);
    const list = (await call(thresholdsList, { cookie: cookie.admin })).data.thresholds;
    expect(list.find((x: { id: string }) => x.id === byModel)).toMatchObject({ qty: 2, state: 'OK', kind: 'ASSET', department_name: null });
    expect(list.find((x: { id: string }) => x.id === hrOnly)).toMatchObject({ qty: 1, department_name: 'HR' });
  });
});

describe('받는 사람', () => {
  it('알림함 권한이 있는 활성 계정만, 그리고 자기 부서 범위에 해당하는 알림만 받는다', async () => {
    const model = await newModel('PERIPHERAL');
    const company = (await post(thresholdCreate, 'admin', { modelId: model, minQty: 1 })).data.thresholdId as string; // 기업 전체, 지금 0개 → 부족
    const hr = (await post(thresholdCreate, 'admin', { modelId: model, departmentId: id.hr, minQty: 1 })).data.thresholdId as string;
    const it = (await post(thresholdCreate, 'admin', { modelId: model, departmentId: id.it, minQty: 1 })).data.thresholdId as string;
    const got = async (who: string) => (await inbox(who)).filter((n) => [company, hr, it].includes(n.payload.thresholdId as string)).map((n) => n.payload.thresholdId);
    expect((await got('admin')).sort()).toEqual([company, hr, it].sort());
    expect((await got('manager')).sort()).toEqual([company, hr, it].sort());
    expect(await got('hrmanager')).toEqual([hr]); // 기업 전체·IT 알림은 받지 않는다
    expect(await got('noinbox')).toEqual([]);
    expect(await got('inactive')).toEqual([]);
    expect(await got('badmin')).toEqual([]);
  });

  it('알림함은 자기 것만 보이고, 남의 알림은 읽음 처리할 수 없다', async () => {
    const mine = await call(alertsList, { cookie: cookie.hrmanager });
    expect(mine.status).toBe(200);
    expect(mine.data.items.length).toBeGreaterThan(0);
    expect(mine.data.unread).toBe(mine.data.total);
    const adminAlert = (await one('SELECT id FROM app.notification WHERE user_id = $1 LIMIT 1', [userId.admin])).id;
    expect((await post(alertsRead, 'hrmanager', { ids: [adminAlert] })).data.updated).toBe(0);
    expect((await one('SELECT read_at FROM app.notification WHERE id = $1', [adminAlert])).read_at).toBeNull();
    expect((await post(alertsRead, 'hrmanager', { ids: [mine.data.items[0].id] })).data.updated).toBe(1);
    expect((await call(alertsList, { cookie: cookie.hrmanager, path: '/api/alerts?unreadOnly=true' })).data.total).toBe(mine.data.total - 1);
    expect((await post(alertsRead, 'hrmanager', { all: true })).data.updated).toBe(mine.data.total - 1);
    expect((await call(alertsList, { cookie: cookie.hrmanager })).data.unread).toBe(0);
    expect((await post(alertsRead, 'hrmanager', { all: true, ids: [adminAlert] })).status).toBe(400);
    expect((await call(alertsList, { cookie: cookie.noinbox })).status).toBe(403);
    expect((await call(alertsList)).status).toBe(401);
    // 다른 기업 관리자의 알림함에는 A 의 알림이 없다.
    expect((await call(alertsList, { cookie: cookie.badmin })).data.total).toBe(0);
  });
});

describe('한계 수량 관리', () => {
  it('대상은 카테고리나 모델 중 하나, 같은 대상·부서는 하나만, 다른 기업의 대상은 쓸 수 없다', async () => {
    const model = await newModel('PERIPHERAL');
    expect((await post(thresholdCreate, 'admin', { minQty: 1 })).status).toBe(400);
    expect((await post(thresholdCreate, 'admin', { modelId: model, categoryId: id.pcat, minQty: 1 })).status).toBe(400);
    expect((await post(thresholdCreate, 'admin', { categoryId: id.bcat, minQty: 1 })).status).toBe(400);
    expect((await post(thresholdCreate, 'admin', { modelId: model, minQty: -1 })).status).toBe(400);
    expect((await post(thresholdCreate, 'admin', { modelId: model, minQty: 1, warnRatio: 0.5 })).status).toBe(400);
    expect((await post(thresholdCreate, 'admin', { modelId: model, minQty: 0 })).status).toBe(201);
    expect((await post(thresholdCreate, 'admin', { modelId: model, minQty: 3 })).status).toBe(409);
    expect((await post(thresholdCreate, 'admin', { modelId: model, departmentId: id.hr, minQty: 3 })).status).toBe(201);
    const both = await Promise.all([1, 2].map(() => post(thresholdCreate, 'admin', { modelId: model, departmentId: id.it, minQty: 3 })));
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('범위가 제한된 사용자는 자기 부서의 한계 수량만 보고 관리하며, 기업 전체 것은 만들 수 없다', async () => {
    const model = await newModel('PERIPHERAL');
    const company = (await post(thresholdCreate, 'admin', { modelId: model, minQty: 0 })).data.thresholdId as string;
    const it = (await post(thresholdCreate, 'admin', { modelId: model, departmentId: id.it, minQty: 0 })).data.thresholdId as string;
    expect((await post(thresholdCreate, 'hrmanager', { categoryId: id.pcat, minQty: 1 })).status).toBe(403);
    expect((await post(thresholdCreate, 'hrmanager', { modelId: model, departmentId: id.it, minQty: 1 })).status).toBe(403);
    const hr = await post(thresholdCreate, 'hrmanager', { modelId: model, departmentId: id.hr, minQty: 0 });
    expect(hr.status).toBe(201);
    const seen = (await call(thresholdsList, { cookie: cookie.hrmanager })).data.thresholds.map((t: { id: string }) => t.id);
    expect(seen).toContain(hr.data.thresholdId);
    expect(seen).not.toContain(company);
    expect(seen).not.toContain(it);
    for (const t of [company, it]) {
      expect((await call(withId(thresholdPatch, t), { method: 'PATCH', cookie: cookie.hrmanager, body: { minQty: 99 } })).status).toBe(404);
      expect((await call(withId(thresholdDelete, t), { method: 'DELETE', cookie: cookie.hrmanager })).status).toBe(404);
    }
    expect((await one('SELECT min_qty FROM app.stock_threshold WHERE id = $1', [company])).min_qty).toBe(0);
    // 다른 기업
    expect((await call(withId(thresholdPatch, company), { method: 'PATCH', cookie: cookie.badmin, body: { minQty: 99 } })).status).toBe(404);
    expect((await call(withId(thresholdDelete, company), { method: 'DELETE', cookie: cookie.badmin })).status).toBe(404);
    expect((await call(thresholdsList, { cookie: cookie.badmin })).data.thresholds).toEqual([]);
    // 권한
    expect((await post(thresholdCreate, 'noinbox', { modelId: model, minQty: 1 })).status).toBe(403);
    expect((await call(withId(thresholdDelete, hr.data.thresholdId), { method: 'DELETE', cookie: cookie.hrmanager })).status).toBe(200);
  });
});

describe('날짜 기준 알림', () => {
  it('보증 만료 임박·대여 연체를 알리고, 몇 번을 계산해도 같은 건은 한 번만 만든다', async () => {
    const o = await owner();
    const model = await newModel('ASSET');
    const pmodel = await newModel('PERIPHERAL');
    const mk = async (over: Record<string, unknown>) => (await post(assetsCreate, 'admin', { modelId: model, assetTag: uniq('DA-'), ...over })).data.assetId as string;
    const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const soon = await mk({ warrantyEnd: day(10) });
    const far = await mk({ warrantyEnd: day(90) });
    const past = await mk({ warrantyEnd: day(-5) });
    const hrSoon = await mk({ warrantyEnd: day(3), departmentId: id.hr });
    const late = await mk({});
    await call(withId(assignRoute, late), { method: 'POST', cookie: cookie.admin, body: { action: 'LOAN', holderPersonId: id.p1, dueDate: day(5) } });
    await o.query("UPDATE app.asset SET due_date = current_date - 3 WHERE id = $1", [late]);
    const stock = (await post(receiveRoute, 'admin', { modelId: pmodel, qty: 5, departmentId: id.hr })).data.stockId as string;
    const loan = (await post(issueRoute, 'admin', { action: 'LOAN', stockId: stock, personId: id.p1, qty: 2, dueDate: day(5) })).data.loanId as string;
    await o.query('UPDATE app.peripheral_loan SET due_date = current_date - 1 WHERE id = $1', [loan]);

    const keysOf = async (who: string) => (await inbox(who)).map((n) => n.payload.key).filter(Boolean) as string[];
    const daily = (company: TestCompany) => withTenant(company.id, (db) => runDailyAlerts(db, company.id));
    expect(await daily(A)).toBeGreaterThan(0);
    const first = await keysOf('admin');
    expect(first.some((k) => k.startsWith(`warranty:${soon}:`))).toBe(true);
    expect(first.some((k) => k.startsWith(`warranty:${hrSoon}:`))).toBe(true);
    expect(first.some((k) => k.includes(far) || k.includes(past))).toBe(false);
    expect(first.some((k) => k.startsWith(`asset-overdue:${late}:`))).toBe(true);
    expect(first.some((k) => k.startsWith(`loan-overdue:${loan}:`))).toBe(true);
    const overdue = (await inbox('admin')).find((n) => n.payload.loanId === loan)!;
    expect(overdue).toMatchObject({ type: 'LOAN_OVERDUE', payload: { holder: 'Kim', qty: 2 } });

    // 다시 계산해도 늘지 않는다.
    expect(await daily(A)).toBe(0);
    expect(await keysOf('admin')).toEqual(first);
    // 범위가 제한된 사용자는 자기 부서 것만 받는다.
    const hrKeys = await keysOf('hrmanager');
    expect(hrKeys.some((k) => k.startsWith(`warranty:${hrSoon}:`))).toBe(true);
    expect(hrKeys.some((k) => k.startsWith(`loan-overdue:${loan}:`))).toBe(true);
    expect(hrKeys.some((k) => k.includes(soon) || k.includes(late))).toBe(false);
    // 다른 기업에는 아무것도 생기지 않는다.
    expect(await daily(B)).toBe(0);
    expect(await keysOf('badmin')).toEqual([]);
    // 기한이 바뀌면 새 건으로 다시 알린다.
    await o.query('UPDATE app.asset SET due_date = current_date - 1 WHERE id = $1', [late]);
    await daily(A);
    expect((await keysOf('admin')).filter((k) => k.startsWith(`asset-overdue:${late}:`)).length).toBe(2);
  });

  it('알림함을 여는 요청은 기업마다 하루에 한 번만 날짜 기준 알림을 계산한다', async () => {
    const C = await makeCompany('ALRC');
    const c = await sessionFor(C.code, 'admin');
    const runs = async () => (await one("SELECT count(*)::int AS n FROM app.audit_log WHERE company_id = $1 AND action = 'DAILY_ALERTS_RUN'", [C.id])).n;
    expect(await runs()).toBe(0);
    await Promise.all(Array.from({ length: 6 }, () => call(alertsList, { cookie: c })));
    expect(await runs()).toBe(1);
    await call(alertsList, { cookie: c, path: '/api/alerts?page=2' });
    await call(alertsList, { cookie: c });
    expect(await runs()).toBe(1);
    // 어제 한 기록만 있으면 오늘 다시 계산한다.
    await (await owner()).query("UPDATE app.audit_log SET created_at = created_at - interval '1 day' WHERE company_id = $1 AND action = 'DAILY_ALERTS_RUN'", [C.id]);
    await call(alertsList, { cookie: c });
    expect(await runs()).toBe(2);
  });

  it('자산 목록에서 연체만 골라 보고 반납 기한으로 정렬할 수 있다', async () => {
    const list = await call(assetsList, { cookie: cookie.admin, path: '/api/assets?overdue=true&sort=due_date&pageSize=200' });
    expect(list.status).toBe(200);
    expect(list.data.total).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(list.data.items.every((a: { state: string; due_date: string }) => a.state === 'IN_USE' && a.due_date < today)).toBe(true);
    expect((await call(assetsList, { cookie: cookie.hrmanager, path: '/api/assets?overdue=true' })).data.total).toBe(0); // 연체 자산은 IT 소속
  });
});

describe('검토에서 드러난, 테스트가 없던 보장', () => {
  it('카테고리에 건 한계 수량은 그 카테고리의 어느 모델이 바뀌어도 판정된다', async () => {
    const o = await owner();
    const cat = (await o.query("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', $2) RETURNING id", [A.id, uniq('Cat')])).rows[0].id as string;
    const mk = async () => (await o.query("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'T', $3) RETURNING id", [A.id, cat, uniq('M')])).rows[0].id as string;
    const [m1, m2] = [await mk(), await mk()];
    const s1 = (await post(receiveRoute, 'admin', { modelId: m1, qty: 3 })).data.stockId as string;
    await post(receiveRoute, 'admin', { modelId: m2, qty: 3 });
    const t = (await post(thresholdCreate, 'admin', { categoryId: cat, minQty: 5 })).data.thresholdId as string;
    expect(await typesFor('admin', t)).toEqual([]); // 3 + 3 = 6
    await post(issueRoute, 'admin', { action: 'ISSUE', stockId: s1, personId: id.p1, qty: 2 }); // 4
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK']);
    await post(receiveRoute, 'admin', { modelId: m2, qty: 1 }); // 5 → 다른 모델의 입고로 회복
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK', 'STOCK_RECOVERED']);
    // 모델을 다른 카테고리로 옮기면 양쪽 카테고리가 다시 판정된다.
    const { PATCH: modelPatch } = await import('@/app/api/master/models/[id]/route');
    expect((await call(withId(modelPatch as Handler, m2), { method: 'PATCH', cookie: cookie.admin, body: { categoryId: id.pcat } })).status).toBe(200);
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK', 'STOCK_RECOVERED', 'LOW_STOCK']); // m1 의 1개만 남음
  });

  it('자산의 배정·반납, 관리 부서 변경도 판정을 일으킨다', async () => {
    const model = await newModel('ASSET');
    const a = (await post(assetsCreate, 'admin', { modelId: model, assetTag: uniq('GA-') })).data.assetId as string;
    const t = (await post(thresholdCreate, 'admin', { modelId: model, departmentId: id.it, minQty: 1 })).data.thresholdId as string;
    expect(await typesFor('admin', t)).toEqual([]);
    await call(withId(assignRoute, a), { method: 'POST', cookie: cookie.admin, body: { action: 'ASSIGN', holderPersonId: id.p1 } });
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK']);
    await call(withId(assignRoute, a), { method: 'POST', cookie: cookie.admin, body: { action: 'RETURN' } });
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK', 'STOCK_RECOVERED']);
    const { PATCH: assetPatch } = await import('@/app/api/assets/[id]/route');
    expect((await call(withId(assetPatch as Handler, a), { method: 'PATCH', cookie: cookie.admin, body: { departmentId: id.hr } })).status).toBe(200);
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK', 'STOCK_RECOVERED', 'LOW_STOCK']); // IT 에는 이제 0대
  });

  it('주변기기 대여 반납도 판정을 일으키고, 부서 한계 수량은 그 부서의 재고만 센다', async () => {
    const model = await newModel('PERIPHERAL');
    const stock = (await post(receiveRoute, 'admin', { modelId: model, qty: 2 })).data.stockId as string; // IT
    const hr = (await post(thresholdCreate, 'admin', { modelId: model, departmentId: id.hr, minQty: 1 })).data.thresholdId as string;
    expect(await typesFor('admin', hr)).toEqual(['LOW_STOCK']); // IT 에 2개 있어도 HR 은 0개
    const it = (await post(thresholdCreate, 'admin', { modelId: model, departmentId: id.it, minQty: 2 })).data.thresholdId as string;
    const loan = (await post(issueRoute, 'admin', { action: 'LOAN', stockId: stock, personId: id.p1, qty: 1 })).data.loanId as string;
    expect(await typesFor('admin', it)).toEqual(['LOW_STOCK']);
    await post(issueRoute, 'admin', { action: 'RETURN', loanId: loan, qty: 1 });
    expect(await typesFor('admin', it)).toEqual(['LOW_STOCK', 'STOCK_RECOVERED']);
  });

  it('꺼진 역할로는 알림을 받지 않는다', async () => {
    const o = await owner();
    await userWith('offrole', [['alert.inbox', 'read']]);
    await o.query('UPDATE app.role SET is_active = false WHERE id IN (SELECT role_id FROM app.user_role WHERE user_id = $1)', [userId.offrole]);
    const model = await newModel('PERIPHERAL');
    const t = (await post(thresholdCreate, 'admin', { modelId: model, minQty: 1 })).data.thresholdId as string;
    expect(await typesFor('admin', t)).toEqual(['LOW_STOCK']);
    expect(await typesFor('offrole', t)).toEqual([]);
  });

  it('퇴역한 자산의 보증, 반납된 자산·종료된 대여의 기한은 알리지 않는다', async () => {
    const o = await owner();
    const { POST: retireRoute } = await import('@/app/api/assets/[id]/retire/route');
    const model = await newModel('ASSET');
    const pmodel = await newModel('PERIPHERAL');
    const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const retired = (await post(assetsCreate, 'admin', { modelId: model, assetTag: uniq('GR-'), warrantyEnd: day(5) })).data.assetId as string;
    await call(withId(retireRoute as Handler, retired), { method: 'POST', cookie: cookie.admin, body: { action: 'RETIRE' } });
    const returned = (await post(assetsCreate, 'admin', { modelId: model, assetTag: uniq('GR-') })).data.assetId as string;
    await call(withId(assignRoute, returned), { method: 'POST', cookie: cookie.admin, body: { action: 'LOAN', holderPersonId: id.p1, dueDate: day(5) } });
    await call(withId(assignRoute, returned), { method: 'POST', cookie: cookie.admin, body: { action: 'RETURN' } });
    await o.query('UPDATE app.asset SET due_date = current_date - 3 WHERE id = $1', [returned]); // 재고 상태인데 기한 값만 남은 경우
    const stock = (await post(receiveRoute, 'admin', { modelId: pmodel, qty: 2 })).data.stockId as string;
    const loan = (await post(issueRoute, 'admin', { action: 'LOAN', stockId: stock, personId: id.p1, qty: 1, dueDate: day(5) })).data.loanId as string;
    await post(issueRoute, 'admin', { action: 'RETURN', loanId: loan, qty: 1 });
    await o.query('UPDATE app.peripheral_loan SET due_date = current_date - 3 WHERE id = $1', [loan]);
    await withTenant(A.id, (db) => runDailyAlerts(db, A.id));
    const keys = (await inbox('admin')).map((n) => String(n.payload.key ?? ''));
    expect(keys.filter((k) => k.includes(retired) || k.includes(returned) || k.includes(loan))).toEqual([]);
  });
});
