// 3단계: 주변기기. 수량 정합성, 부서 범위, 기업 격리, 권한, 동시성.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as deactivatePerson } from '@/app/api/master/persons/[id]/deactivate/route';
import { GET as historyRoute } from '@/app/api/peripherals/[id]/history/route';
import { POST as adjustRoute } from '@/app/api/peripherals/adjust/route';
import { POST as issueRoute } from '@/app/api/peripherals/issue/route';
import { GET as loansRoute } from '@/app/api/peripherals/loans/route';
import { POST as receiveRoute } from '@/app/api/peripherals/receive/route';
import { GET as stockList } from '@/app/api/peripherals/route';
import { closePool } from '@/lib/db/pool';
import { call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};

type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });
const one = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];
const post = (h: Handler, as: string, body: Record<string, unknown>) => call(h, { method: 'POST', cookie: cookie[as], body });
const qty = async (stockId: string) => {
  const r = await one('SELECT on_hand_qty, on_loan_qty FROM app.peripheral_stock WHERE id = $1', [stockId]);
  return `${r.on_hand_qty}/${r.on_loan_qty}`;
};

async function seed(c: TestCompany, prefix: string): Promise<void> {
  const o = await owner();
  const q = async (sql: string, p: unknown[]) => (await o.query(sql, p)).rows[0].id as string;
  id[`${prefix}it`] = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [c.id])).rows[0].id;
  id[`${prefix}hr`] = await q("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [c.id]);
  const pcat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Mouse') RETURNING id", [c.id]);
  const acat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [c.id]);
  id[`${prefix}mouse`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'Logi', 'M1') RETURNING id", [c.id, pcat]);
  id[`${prefix}kbd`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'Logi', 'K1') RETURNING id", [c.id, pcat]);
  id[`${prefix}off`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name, is_active) VALUES ($1, $2, 'PERIPHERAL', 'Old', 'Z', false) RETURNING id", [c.id, pcat]);
  id[`${prefix}laptop`] = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Lenovo', 'X1') RETURNING id", [c.id, acat]);
  id[`${prefix}p1`] = await q("INSERT INTO app.person (company_id, name) VALUES ($1, 'Kim') RETURNING id", [c.id]);
  id[`${prefix}p2`] = await q("INSERT INTO app.person (company_id, name) VALUES ($1, 'Lee') RETURNING id", [c.id]);
  id[`${prefix}gone`] = await q("INSERT INTO app.person (company_id, name, is_active) VALUES ($1, 'Gone', false) RETURNING id", [c.id]);
}

async function userWith(loginId: string, acl: [string, string][] | string, deptIds: string[] = []): Promise<void> {
  const o = await owner();
  const userId = await makeUser(A.id, loginId, 'COMPANY_USER');
  let roleId: string;
  if (typeof acl === 'string') roleId = (await o.query('SELECT id FROM app.role WHERE company_id = $1 AND name = $2', [A.id, acl])).rows[0].id;
  else {
    roleId = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [A.id, uniq('role')])).rows[0].id;
    for (const [r, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [roleId, r, op]);
  }
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [userId, roleId, A.id]);
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [userId, d, A.id]);
  cookie[loginId] = await sessionFor(A.code, loginId);
}

/** 새 모델로 재고 행을 하나 만든다(테스트끼리 수량이 섞이지 않게). */
async function freshStock(qtyIn: number, departmentId?: string): Promise<string> {
  const o = await owner();
  const cat = (await o.query("SELECT id FROM app.category WHERE company_id = $1 AND kind = 'PERIPHERAL' LIMIT 1", [A.id])).rows[0].id;
  const model = (await o.query("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'T', $3) RETURNING id", [A.id, cat, uniq('M')])).rows[0].id;
  const r = await post(receiveRoute, 'admin', { modelId: model, qty: qtyIn, ...(departmentId ? { departmentId } : {}) });
  expect(r.status).toBe(200);
  return r.data.stockId as string;
}

beforeAll(async () => {
  A = await makeCompany('PERA');
  B = await makeCompany('PERB');
  await seed(A, '');
  await seed(B, 'b');
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  await userWith('viewer', 'Viewer');
  await userWith('oper', 'Stock Operator'); // 입고·지급은 되고 조정은 안 된다
  await userWith('hroper', 'Stock Manager', [id.hr!]);
  await userWith('receiver', [['peripheral.stock', 'read'], ['peripheral.receive', 'execute']]);
  await userWith('issuer', [['peripheral.stock', 'read'], ['peripheral.issue', 'execute']]);
  await userWith('adjuster', [['peripheral.stock', 'read'], ['peripheral.adjust', 'execute']]);
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('입고와 수량', () => {
  it('입고하면 (모델, 부서) 재고가 생기고, 다시 입고하면 같은 행에 더해진다', async () => {
    const first = await post(receiveRoute, 'admin', { modelId: id.mouse, qty: 10 });
    expect(first.status).toBe(200);
    expect(first.data.onHandQty).toBe(10);
    const again = await post(receiveRoute, 'admin', { modelId: id.mouse, qty: 5, note: '2차' });
    expect(again.data).toEqual({ stockId: first.data.stockId, onHandQty: 15 });
    const hr = await post(receiveRoute, 'admin', { modelId: id.mouse, departmentId: id.hr, qty: 3 });
    expect(hr.data.stockId).not.toBe(first.data.stockId);
    expect((await one('SELECT department_id FROM app.peripheral_stock WHERE id = $1', [first.data.stockId])).department_id).toBe(id.it);
    const list = await call(stockList, { cookie: cookie.admin, path: `/api/peripherals?modelId=${id.mouse}` });
    expect(list.data.total).toBe(2);
    expect(list.data.items.map((s: { on_hand_qty: number }) => s.on_hand_qty).sort()).toEqual([15, 3].sort());
  });

  it('자산용 모델, 비활성 모델, 다른 기업의 모델·부서, 잘못된 수량은 거부한다', async () => {
    for (const body of [
      { modelId: id.laptop, qty: 1 },
      { modelId: id.off, qty: 1 },
      { modelId: id.bmouse, qty: 1 },
      { modelId: id.mouse, departmentId: id.bit, qty: 1 },
      { modelId: id.mouse, qty: 0 },
      { modelId: id.mouse, qty: -3 },
      { modelId: id.mouse, qty: 1.5 },
      { modelId: id.mouse, qty: 1_000_001 },
      { modelId: id.mouse, qty: 1, companyId: B.id },
    ]) expect((await post(receiveRoute, 'admin', body)).status, JSON.stringify(body)).toBe(400);
  });

  it('같은 (모델, 부서)에 동시에 입고해도 행은 하나이고 수량은 모두 더해진다', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => post(receiveRoute, 'admin', { modelId: id.kbd, qty: 7 })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const rows = (await (await owner()).query('SELECT on_hand_qty FROM app.peripheral_stock WHERE company_id = $1 AND model_id = $2', [A.id, id.kbd])).rows;
    expect(rows).toEqual([{ on_hand_qty: 42 }]);
  });
});

describe('지급·대여·반납', () => {
  it('지급은 보유 수량만 줄이고, 대여는 대여 중 수량을 늘리며, 반납·분실로 닫힌다', async () => {
    const s = await freshStock(10);
    expect((await post(issueRoute, 'admin', { action: 'ISSUE', stockId: s, personId: id.p1, qty: 2 })).status).toBe(200);
    expect(await qty(s)).toBe('8/0');
    const loan = await post(issueRoute, 'admin', { action: 'LOAN', stockId: s, personId: id.p2, qty: 5, dueDate: '2027-03-01', locationNote: '회의실' });
    expect(loan.status).toBe(200);
    expect(await qty(s)).toBe('3/5');
    const loanId = loan.data.loanId as string;

    expect((await post(issueRoute, 'admin', { action: 'RETURN', loanId, qty: 6 })).status).toBe(409); // 미반납보다 많음
    expect((await post(issueRoute, 'admin', { action: 'RETURN', loanId, qty: 3 })).status).toBe(200);
    expect(await qty(s)).toBe('6/2');
    expect((await one('SELECT status, returned_qty, lost_qty FROM app.peripheral_loan WHERE id = $1', [loanId]))).toEqual({ status: 'OPEN', returned_qty: 3, lost_qty: 0 });
    expect((await post(issueRoute, 'admin', { action: 'LOAN_LOSS', loanId, qty: 1 })).status).toBe(200);
    expect(await qty(s)).toBe('6/1'); // 분실은 보유 수량으로 돌아오지 않는다
    expect((await post(issueRoute, 'admin', { action: 'RETURN', loanId, qty: 1 })).status).toBe(200);
    expect(await qty(s)).toBe('7/0');
    const closed = await one('SELECT status, returned_qty, lost_qty, closed_at FROM app.peripheral_loan WHERE id = $1', [loanId]);
    expect(closed).toMatchObject({ status: 'CLOSED', returned_qty: 4, lost_qty: 1 });
    expect(closed.closed_at).not.toBeNull();
    expect((await post(issueRoute, 'admin', { action: 'RETURN', loanId, qty: 1 })).status).toBe(409); // 이미 종료

    // 이력: 부호와 순서. 합계는 현재 보유 수량과 맞는다(분실 제외).
    const h = await call(withId(historyRoute, s), { cookie: cookie.admin });
    const rows = h.data.history.map((t: { type: string; qty: number }) => `${t.type}:${t.qty}`).reverse();
    expect(rows).toEqual(['RECEIVE:10', 'ISSUE:-2', 'LOAN:-5', 'RETURN:3', 'LOAN_LOSS:-1', 'RETURN:1']);
    expect(h.data.history.find((t: { type: string }) => t.type === 'LOAN')).toMatchObject({ person_name: 'Lee', location_note: '회의실', actor_name: 'Admin' });
  });

  it('재고보다 많이 지급·대여할 수 없고, 수량은 그대로다', async () => {
    const s = await freshStock(3);
    expect((await post(issueRoute, 'admin', { action: 'ISSUE', stockId: s, personId: id.p1, qty: 4 })).status).toBe(409);
    expect((await post(issueRoute, 'admin', { action: 'LOAN', stockId: s, personId: id.p1, qty: 4 })).status).toBe(409);
    expect(await qty(s)).toBe('3/0');
    expect((await one('SELECT count(*)::int AS n FROM app.peripheral_loan WHERE stock_id = $1', [s])).n).toBe(0);
  });

  it('비활성 직원, 다른 기업의 직원에게는 지급·대여할 수 없다', async () => {
    const s = await freshStock(3);
    expect((await post(issueRoute, 'admin', { action: 'ISSUE', stockId: s, personId: id.gone, qty: 1 })).status).toBe(400);
    expect((await post(issueRoute, 'admin', { action: 'LOAN', stockId: s, personId: id.bp1, qty: 1 })).status).toBe(400);
    expect(await qty(s)).toBe('3/0');
  });

  it('동시에 지급해도 재고가 음수가 되지 않는다', async () => {
    const s = await freshStock(5);
    const results = await Promise.all(Array.from({ length: 8 }, () => post(issueRoute, 'admin', { action: 'ISSUE', stockId: s, personId: id.p1, qty: 1 })));
    expect(results.filter((r) => r.status === 200).length).toBe(5);
    expect(results.filter((r) => r.status === 409).length).toBe(3);
    expect(await qty(s)).toBe('0/0');
    expect((await one("SELECT coalesce(sum(qty), 0)::int AS n FROM app.peripheral_txn WHERE stock_id = $1 AND type = 'ISSUE'", [s])).n).toBe(-5);
  });

  it('같은 대여를 동시에 반납해도 미반납 수량을 넘지 않는다', async () => {
    const s = await freshStock(4);
    const loanId = (await post(issueRoute, 'admin', { action: 'LOAN', stockId: s, personId: id.p1, qty: 4 })).data.loanId as string;
    const results = await Promise.all(Array.from({ length: 4 }, () => post(issueRoute, 'admin', { action: 'RETURN', loanId, qty: 3 })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await qty(s)).toBe('3/1');
  });

  it('미반납 대여가 있는 직원은 퇴사 처리할 수 없고, 대여와 퇴사 처리가 겹쳐도 퇴사자가 대여를 갖지 않는다', async () => {
    const o = await owner();
    for (let i = 0; i < 8; i++) {
      const s = await freshStock(2);
      const personId = (await o.query('INSERT INTO app.person (company_id, name) VALUES ($1, $2) RETURNING id', [A.id, uniq('Race')])).rows[0].id as string;
      const calls = [
        post(issueRoute, 'admin', { action: 'LOAN', stockId: s, personId, qty: 1 }),
        call(withId(deactivatePerson as Handler, personId), { method: 'POST', cookie: cookie.admin }),
      ];
      await Promise.all(i % 2 ? calls.reverse() : calls);
      const row = await one(
        "SELECT p.is_active, (SELECT count(*)::int FROM app.peripheral_loan WHERE person_id = p.id AND status = 'OPEN') AS open FROM app.person p WHERE p.id = $1",
        [personId],
      );
      expect(row.is_active === false && row.open > 0, `i=${i}`).toBe(false);
    }
  });
});

describe('조정과 폐기', () => {
  it('실사 조정은 센 수량으로 맞추고, 폐기는 수량만큼 줄이며, 사유가 필수이고 감사 로그에 남는다', async () => {
    const s = await freshStock(10);
    expect((await post(adjustRoute, 'admin', { action: 'ADJUST', stockId: s, countedQty: 8 })).status).toBe(400); // 사유 없음
    expect((await post(adjustRoute, 'admin', { action: 'ADJUST', stockId: s, countedQty: 8, note: '  ' })).status).toBe(400);
    expect((await post(adjustRoute, 'admin', { action: 'ADJUST', stockId: s, countedQty: -1, note: 'x' })).status).toBe(400);
    expect((await post(adjustRoute, 'admin', { action: 'ADJUST', stockId: s, countedQty: 10, note: '같음' })).status).toBe(409);
    expect((await post(adjustRoute, 'admin', { action: 'ADJUST', stockId: s, countedQty: 8, note: '실사 결과' })).data.onHandQty).toBe(8);
    expect((await post(adjustRoute, 'admin', { action: 'ADJUST', stockId: s, countedQty: 9, note: '재실사' })).status).toBe(200);
    expect((await post(adjustRoute, 'admin', { action: 'DISPOSE', stockId: s, qty: 10, note: '고장' })).status).toBe(409);
    expect((await post(adjustRoute, 'admin', { action: 'DISPOSE', stockId: s, qty: 4, note: '고장' })).status).toBe(200);
    expect(await qty(s)).toBe('5/0');
    const txns = (await (await owner()).query("SELECT type, qty, note FROM app.peripheral_txn WHERE stock_id = $1 AND type IN ('ADJUST', 'DISPOSE') ORDER BY created_at, id", [s])).rows;
    expect(txns).toEqual([
      { type: 'ADJUST', qty: -2, note: '실사 결과' },
      { type: 'ADJUST', qty: 1, note: '재실사' },
      { type: 'DISPOSE', qty: -4, note: '고장' },
    ]);
    const audit = (await (await owner()).query('SELECT action FROM app.audit_log WHERE target_id = $1 ORDER BY created_at, id', [s])).rows.map((r) => r.action);
    expect(audit).toEqual(['PERIPHERAL_ADJUSTED', 'PERIPHERAL_ADJUSTED', 'PERIPHERAL_DISPOSED']);
  });

  it('조정은 대여 중 수량을 건드리지 않는다', async () => {
    const s = await freshStock(5);
    await post(issueRoute, 'admin', { action: 'LOAN', stockId: s, personId: id.p1, qty: 2 });
    await post(adjustRoute, 'admin', { action: 'ADJUST', stockId: s, countedQty: 0, note: '창고 침수' });
    expect(await qty(s)).toBe('0/2');
  });
});

describe('권한', () => {
  it('처리마다 필요한 권한이 다르다', async () => {
    const s = await freshStock(10);
    const receive = { modelId: id.mouse, qty: 1 };
    const issue = { action: 'ISSUE', stockId: s, personId: id.p1, qty: 1 };
    const adjust = { action: 'ADJUST', stockId: s, countedQty: 1, note: 'x' };
    const expected: Record<string, [number, number, number]> = {
      viewer: [403, 403, 403],
      receiver: [200, 403, 403],
      issuer: [403, 200, 403],
      adjuster: [403, 403, 200],
    };
    for (const [who, [r, i, a]] of Object.entries(expected)) {
      expect((await post(receiveRoute, who, receive)).status, `${who} receive`).toBe(r);
      expect((await post(issueRoute, who, issue)).status, `${who} issue`).toBe(i);
      expect((await post(adjustRoute, who, adjust)).status, `${who} adjust`).toBe(a);
    }
    // 지급 라우트에 조정을 실어 보내거나 그 반대로 보내도 받지 않는다.
    expect((await post(issueRoute, 'issuer', adjust)).status).toBe(400);
    expect((await post(adjustRoute, 'adjuster', issue)).status).toBe(400);
    // 대여 현황·이력은 각자의 조회 권한이 필요하다.
    expect((await call(loansRoute, { cookie: cookie.receiver })).status).toBe(403);
    expect((await call(withId(historyRoute, s), { cookie: cookie.receiver })).status).toBe(403);
    expect((await call(loansRoute, { cookie: cookie.viewer })).status).toBe(200);
    expect((await call(stockList)).status).toBe(401);
  });
});

describe('부서 범위와 다른 기업', () => {
  let itStock: string;
  let hrStock: string;
  let itLoan: string;
  let hrLoan: string;
  beforeAll(async () => {
    itStock = await freshStock(10, id.it);
    hrStock = await freshStock(10, id.hr);
    itLoan = (await post(issueRoute, 'admin', { action: 'LOAN', stockId: itStock, personId: id.p1, qty: 2, dueDate: '2020-01-01' })).data.loanId;
    hrLoan = (await post(issueRoute, 'admin', { action: 'LOAN', stockId: hrStock, personId: id.p1, qty: 2 })).data.loanId;
  });

  it('범위 밖 재고·대여는 목록과 건수에 없고, ID로 지정해도 없는 것으로 응답한다', async () => {
    const list = await call(stockList, { cookie: cookie.hroper, path: '/api/peripherals?pageSize=200' });
    const ids = list.data.items.map((s: { id: string }) => s.id);
    expect(ids).toContain(hrStock);
    expect(ids).not.toContain(itStock);
    expect(list.data.total).toBe(ids.length);
    expect(list.data.items.every((s: { department_id: string }) => s.department_id === id.hr)).toBe(true);
    expect((await call(stockList, { cookie: cookie.hroper, path: `/api/peripherals?departmentId=${id.it}` })).data.total).toBe(0);

    const loans = await call(loansRoute, { cookie: cookie.hroper, path: '/api/peripherals/loans?status=ALL&pageSize=200' });
    const loanIds = loans.data.items.map((l: { id: string }) => l.id);
    expect(loanIds).toContain(hrLoan);
    expect(loanIds).not.toContain(itLoan);
    expect(loans.data.total).toBe(loanIds.length);

    for (const body of [
      { action: 'ISSUE', stockId: itStock, personId: id.p1, qty: 1 },
      { action: 'LOAN', stockId: itStock, personId: id.p1, qty: 1 },
      { action: 'RETURN', loanId: itLoan, qty: 1 },
      { action: 'LOAN_LOSS', loanId: itLoan, qty: 1 },
    ]) expect((await post(issueRoute, 'hroper', body)).status, body.action).toBe(404);
    expect((await post(adjustRoute, 'hroper', { action: 'ADJUST', stockId: itStock, countedQty: 0, note: 'x' })).status).toBe(404);
    expect((await post(adjustRoute, 'hroper', { action: 'DISPOSE', stockId: itStock, qty: 1, note: 'x' })).status).toBe(404);
    expect((await call(withId(historyRoute, itStock), { cookie: cookie.hroper })).status).toBe(404);
    expect(await qty(itStock)).toBe('8/2');
    // 자기 범위 안에서는 된다.
    expect((await post(issueRoute, 'hroper', { action: 'RETURN', loanId: hrLoan, qty: 1 })).status).toBe(200);
  });

  it('범위가 제한된 사용자는 자기 범위 안에만 입고할 수 있다', async () => {
    expect((await post(receiveRoute, 'hroper', { modelId: id.mouse, qty: 1 })).status).toBe(400); // 기본 부서는 범위 밖
    expect((await post(receiveRoute, 'hroper', { modelId: id.mouse, departmentId: id.it, qty: 1 })).status).toBe(403);
    expect((await post(receiveRoute, 'hroper', { modelId: id.mouse, departmentId: id.hr, qty: 1 })).status).toBe(200);
  });

  it('연체 필터와 기본 필터(미반납만)', async () => {
    const overdue = await call(loansRoute, { cookie: cookie.admin, path: '/api/peripherals/loans?overdue=true&pageSize=200' });
    const ids = overdue.data.items.map((l: { id: string }) => l.id);
    expect(ids).toContain(itLoan);
    expect(ids).not.toContain(hrLoan); // 기한 없음
    expect(overdue.data.items.every((l: { overdue: boolean }) => l.overdue)).toBe(true);
    const open = await call(loansRoute, { cookie: cookie.admin, path: '/api/peripherals/loans?pageSize=200' });
    expect(open.data.items.every((l: { status: string }) => l.status === 'OPEN')).toBe(true);
    const mine = open.data.items.find((l: { id: string }) => l.id === itLoan);
    expect(mine).toMatchObject({ person_name: 'Kim', qty: 2, outstanding_qty: 2, due_date: '2020-01-01', overdue: true });
  });

  it('다른 기업 계정은 재고·대여를 ID로 지정해도 찾을 수 없고 목록에도 없다', async () => {
    for (const body of [
      { action: 'ISSUE', stockId: itStock, personId: id.bp1, qty: 1 },
      { action: 'RETURN', loanId: itLoan, qty: 1 },
    ]) expect((await post(issueRoute, 'badmin', body)).status).toBe(404);
    expect((await post(adjustRoute, 'badmin', { action: 'ADJUST', stockId: itStock, countedQty: 0, note: 'x' })).status).toBe(404);
    expect((await call(withId(historyRoute, itStock), { cookie: cookie.badmin })).status).toBe(404);
    expect((await call(stockList, { cookie: cookie.badmin, path: '/api/peripherals?pageSize=200' })).data.total).toBe(0);
    expect((await call(loansRoute, { cookie: cookie.badmin, path: '/api/peripherals/loans?status=ALL' })).data.total).toBe(0);
    expect(await qty(itStock)).toBe('8/2');
  });
});
