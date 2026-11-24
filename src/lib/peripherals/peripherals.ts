// 주변기기: 수량만 관리한다. 재고는 (모델, 관리 부서)마다 한 행이고, 변동은 모두 peripheral_txn 에 남긴다.
// 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 규칙
//  - 부서 범위: 재고·대여·이력 모두 관리 부서로 제한한다. 범위 밖은 없는 것으로 응답한다(404).
//  - 수량은 재고 행을 잠근(FOR UPDATE) 뒤에 검사하고 바꾼다. 음수가 되는 처리는 거부한다(DB CHECK 가 최종 안전망).
//  - 지급(ISSUE)은 돌려받지 않는 소모성 출고, 대여(LOAN)는 돌려받을 것. 대여만 미반납 현황에 잡힌다.
//  - 이력의 qty 부호: 보유 수량이 늘면 +, 줄면 -. 대여 분실(LOAN_LOSS)은 대여 중 수량이 줄어든 것이라 -.
import type { Db } from '@/lib/db/context';
import { evaluateForModel } from '@/lib/alerts/thresholds';
import { writeAudit } from '@/lib/auth/audit';
import type { DataAccess } from '@/lib/authz/scope';
import { badRequest, forbidden, HttpError, notFound } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';

const conflict = (code: string, message: string) => new HttpError(409, code, message);
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const paging = (q: { page?: number; pageSize?: number }) => {
  const pageSize = Math.min(Math.max(q.pageSize ?? 50, 1), 200);
  const page = Math.max(q.page ?? 1, 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
};

// ─────────────────────────── 재고 조회 ───────────────────────────

// $1 기업, $2 부서 범위(NULL = 전체)
const SQL_STOCK_FROM =
  ' FROM app.peripheral_stock s' +
  ' JOIN app.item_model m ON m.id = s.model_id AND m.company_id = s.company_id' +
  ' JOIN app.category c ON c.id = m.category_id AND c.company_id = s.company_id' +
  ' JOIN app.department d ON d.id = s.department_id AND d.company_id = s.company_id' +
  ' WHERE s.company_id = $1 AND ($2::uuid[] IS NULL OR s.department_id = ANY($2))';
const SQL_STOCK_FILTERS =
  ' AND ($3::uuid IS NULL OR s.model_id = $3)' +
  ' AND ($4::uuid IS NULL OR m.category_id = $4)' +
  ' AND ($5::uuid IS NULL OR s.department_id = $5)' +
  ' AND ($6::text IS NULL OR m.name ILIKE $6 OR m.manufacturer ILIKE $6 OR c.name ILIKE $6)';
const SQL_STOCK_COLUMNS =
  'SELECT s.id, s.model_id, m.manufacturer, m.name AS model_name, m.is_active AS model_active, m.category_id, c.name AS category_name,' +
  ' s.department_id, d.name AS department_name, s.on_hand_qty, s.on_loan_qty, s.updated_at';
const SQL_STOCK_COUNT = 'SELECT count(*)::int AS n' + SQL_STOCK_FROM + SQL_STOCK_FILTERS;
const SQL_STOCK_PAGE =
  SQL_STOCK_COLUMNS + SQL_STOCK_FROM + SQL_STOCK_FILTERS + ' ORDER BY lower(c.name), lower(m.manufacturer), lower(m.name), lower(d.name), s.id LIMIT $7 OFFSET $8';
const SQL_STOCK_LOCK =
  'SELECT s.id, s.model_id, s.department_id, s.on_hand_qty, s.on_loan_qty FROM app.peripheral_stock s' +
  ' WHERE s.id = $1 AND s.company_id = $2 AND ($3::uuid[] IS NULL OR s.department_id = ANY($3)) FOR UPDATE';

export interface StockRow {
  id: string;
  model_id: string;
  manufacturer: string;
  model_name: string;
  model_active: boolean;
  category_id: string;
  category_name: string;
  department_id: string;
  department_name: string;
  on_hand_qty: number;
  on_loan_qty: number;
  updated_at: string;
}

export interface StockListQuery {
  modelId?: string;
  categoryId?: string;
  departmentId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listStock(db: Db, actor: Actor, access: DataAccess, query: StockListQuery) {
  const { page, pageSize, offset } = paging(query);
  const q = query.q?.trim();
  const filters = [actor.companyId, access.scope, query.modelId ?? null, query.categoryId ?? null, query.departmentId ?? null, q ? likePattern(q) : null];
  const count = await db.query<{ n: number }>(SQL_STOCK_COUNT, filters);
  const rows = await db.query<StockRow>(SQL_STOCK_PAGE, [...filters, pageSize, offset]);
  return { total: count.rows[0]?.n ?? 0, page, pageSize, items: rows.rows };
}

interface LockedStock {
  id: string;
  model_id: string;
  department_id: string;
  on_hand_qty: number;
  on_loan_qty: number;
}

/** 범위 안의 재고 행을 잠그고 읽는다. 다른 기업·범위 밖은 없는 것으로 응답한다. */
async function lockStock(db: Db, actor: Actor, access: DataAccess, stockId: string): Promise<LockedStock> {
  const { rows } = await db.query<LockedStock>(SQL_STOCK_LOCK, [stockId, actor.companyId, access.scope]);
  const stock = rows[0];
  if (!stock) throw notFound();
  return stock;
}

// ─────────────────────────── 이력 ───────────────────────────

const SQL_STOCK_HISTORY =
  'SELECT t.id, t.type, t.qty, t.person_id, p.name AS person_name, t.loan_id, t.location_note, t.note, u.display_name AS actor_name, t.created_at' +
  ' FROM app.peripheral_txn t' +
  ' LEFT JOIN app.person p ON p.id = t.person_id AND p.company_id = t.company_id' +
  ' LEFT JOIN app.app_user u ON u.id = t.actor_id' +
  ' WHERE t.stock_id = $1 AND t.company_id = $2 ORDER BY t.created_at DESC, t.seq DESC LIMIT $3 OFFSET $4';
const SQL_STOCK_VISIBLE =
  'SELECT 1 FROM app.peripheral_stock s WHERE s.id = $1 AND s.company_id = $2 AND ($3::uuid[] IS NULL OR s.department_id = ANY($3))';

export async function listStockHistory(db: Db, actor: Actor, access: DataAccess, stockId: string, query: { page?: number; pageSize?: number }) {
  const visible = await db.query(SQL_STOCK_VISIBLE, [stockId, actor.companyId, access.scope]);
  if (!visible.rowCount) throw notFound();
  const { page, pageSize, offset } = paging(query);
  const { rows } = await db.query(SQL_STOCK_HISTORY, [stockId, actor.companyId, pageSize, offset]);
  return { page, pageSize, history: rows };
}

// ─────────────────────────── 공통 ───────────────────────────

async function assertPeripheralModel(db: Db, actor: Actor, modelId: string): Promise<void> {
  // FOR SHARE: 확인과 저장 사이에 모델이 비활성화·삭제되지 않게 한다.
  const { rowCount } = await db.query(
    "SELECT 1 FROM app.item_model WHERE id = $1 AND company_id = $2 AND kind = 'PERIPHERAL' AND is_active FOR SHARE",
    [modelId, actor.companyId],
  );
  if (!rowCount) throw badRequest('선택할 수 없는 모델입니다. (주변기기용 모델만 가능합니다)');
}

async function assertActivePerson(db: Db, actor: Actor, personId: string): Promise<void> {
  // FOR SHARE: 퇴사 처리(직원 행 FOR UPDATE + 미반납 대여 검사)와 줄을 세운다.
  const { rowCount } = await db.query('SELECT 1 FROM app.person WHERE id = $1 AND company_id = $2 AND is_active FOR SHARE', [personId, actor.companyId]);
  if (!rowCount) throw badRequest('선택할 수 없는 직원입니다.');
}

interface TxnInput {
  type: 'INITIAL' | 'RECEIVE' | 'ISSUE' | 'LOAN' | 'RETURN' | 'LOAN_LOSS' | 'DISPOSE' | 'ADJUST';
  qty: number;
  personId?: string | null;
  loanId?: string | null;
  locationNote?: string | null;
  note?: string | null;
}

async function writeTxn(db: Db, actor: Actor, stockId: string, t: TxnInput): Promise<void> {
  await db.query(
    `INSERT INTO app.peripheral_txn (company_id, stock_id, type, qty, person_id, loan_id, location_note, note, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actor.companyId, stockId, t.type, t.qty, t.personId ?? null, t.loanId ?? null, t.locationNote?.trim() || null, t.note?.trim() || null, actor.userId],
  );
}

async function setQty(db: Db, actor: Actor, stockId: string, onHand: number, onLoan: number): Promise<void> {
  await db.query('UPDATE app.peripheral_stock SET on_hand_qty = $2, on_loan_qty = $3 WHERE id = $1 AND company_id = $4', [stockId, onHand, onLoan, actor.companyId]);
}

const shortage = (have: number) => conflict('INSUFFICIENT_STOCK', `재고가 부족합니다. (현재 ${have}개)`);
export const MAX_QTY = 1_000_000;
const tooMany = () => badRequest('수량이 너무 큽니다.');

// ─────────────────────────── 입고 ───────────────────────────

export interface ReceiveInput {
  modelId: string;
  departmentId?: string | null;
  qty: number;
  /** 기존 재고를 옮겨 적는 최초 입력(엑셀 업로드 등)이면 INITIAL 로 남긴다. */
  initial?: boolean;
  note?: string | null;
}

/** 입고. (모델, 부서)의 재고 행이 없으면 만든다. */
export async function receiveStock(db: Db, actor: Actor, access: DataAccess, input: ReceiveInput): Promise<{ stockId: string; onHandQty: number }> {
  await assertPeripheralModel(db, actor, input.modelId);
  let departmentId = input.departmentId ?? null;
  if (departmentId) {
    if (!access.inScope(departmentId)) throw forbidden('자신의 부서 범위 밖에는 입고할 수 없습니다.');
    const dept = await db.query('SELECT 1 FROM app.department WHERE id = $1 AND company_id = $2 AND is_active FOR SHARE', [departmentId, actor.companyId]);
    if (!dept.rowCount) throw badRequest('선택할 수 없는 부서입니다.');
  } else {
    const def = await db.query<{ id: string }>('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [actor.companyId]);
    departmentId = def.rows[0]?.id ?? null;
    if (!departmentId || !access.inScope(departmentId)) throw badRequest('관리 부서를 지정해야 합니다.');
  }
  // 같은 (모델, 부서)에 동시에 입고해도 행은 하나만 생긴다. 수량은 잠근 뒤에 더한다.
  await db.query(
    'INSERT INTO app.peripheral_stock (company_id, model_id, department_id) VALUES ($1, $2, $3) ON CONFLICT (company_id, model_id, department_id) DO NOTHING',
    [actor.companyId, input.modelId, departmentId],
  );
  const found = await db.query<{ id: string }>(
    'SELECT id FROM app.peripheral_stock WHERE company_id = $1 AND model_id = $2 AND department_id = $3',
    [actor.companyId, input.modelId, departmentId],
  );
  const stock = await lockStock(db, actor, access, found.rows[0]!.id);
  const onHand = stock.on_hand_qty + input.qty;
  // 상한은 보유 + 대여 중 합계에 건다. 그래야 대여 중인 물건이 돌아와도 상한에 걸리지 않는다.
  if (onHand + stock.on_loan_qty > MAX_QTY) throw tooMany();
  await setQty(db, actor, stock.id, onHand, stock.on_loan_qty);
  await writeTxn(db, actor, stock.id, { type: input.initial ? 'INITIAL' : 'RECEIVE', qty: input.qty, note: input.note });
  await evaluateForModel(db, actor.companyId, stock.model_id);
  return { stockId: stock.id, onHandQty: onHand };
}

// ─────────────────────────── 지급·대여·반납 ───────────────────────────

export type IssueInput =
  | { action: 'ISSUE'; stockId: string; personId: string; qty: number; locationNote?: string | null; note?: string | null }
  | { action: 'LOAN'; stockId: string; personId: string; qty: number; dueDate?: string | null; locationNote?: string | null; note?: string | null }
  | { action: 'RETURN' | 'LOAN_LOSS'; loanId: string; qty: number; note?: string | null };

interface LockedLoan {
  id: string;
  stock_id: string;
  person_id: string;
  qty: number;
  returned_qty: number;
  lost_qty: number;
  status: 'OPEN' | 'CLOSED';
}

export async function issueStock(db: Db, actor: Actor, access: DataAccess, input: IssueInput): Promise<{ stockId: string; loanId: string | null; onHandQty: number; onLoanQty: number }> {
  if (input.action === 'ISSUE' || input.action === 'LOAN') {
    const stock = await lockStock(db, actor, access, input.stockId);
    await assertActivePerson(db, actor, input.personId);
    if (stock.on_hand_qty < input.qty) throw shortage(stock.on_hand_qty);
    const onHand = stock.on_hand_qty - input.qty;
    const onLoan = input.action === 'LOAN' ? stock.on_loan_qty + input.qty : stock.on_loan_qty;
    let loanId: string | null = null;
    if (input.action === 'LOAN') {
      const loan = await db.query<{ id: string }>(
        'INSERT INTO app.peripheral_loan (company_id, stock_id, person_id, qty, due_date) VALUES ($1, $2, $3, $4, $5::date) RETURNING id',
        [actor.companyId, stock.id, input.personId, input.qty, input.dueDate ?? null],
      );
      loanId = loan.rows[0]!.id;
    }
    await setQty(db, actor, stock.id, onHand, onLoan);
    await writeTxn(db, actor, stock.id, { type: input.action, qty: -input.qty, personId: input.personId, loanId, locationNote: input.locationNote, note: input.note });
    await evaluateForModel(db, actor.companyId, stock.model_id);
    return { stockId: stock.id, loanId, onHandQty: onHand, onLoanQty: onLoan };
  }

  // 반납·분실: 대여 건에서 재고를 찾는다. 잠금 순서는 항상 재고 → 대여(교착 방지).
  const ref = await db.query<{ stock_id: string }>('SELECT stock_id FROM app.peripheral_loan WHERE id = $1 AND company_id = $2', [input.loanId, actor.companyId]);
  if (!ref.rows[0]) throw notFound();
  const stock = await lockStock(db, actor, access, ref.rows[0].stock_id); // 범위 밖이면 여기서 404
  const { rows } = await db.query<LockedLoan>(
    'SELECT id, stock_id, person_id, qty, returned_qty, lost_qty, status FROM app.peripheral_loan WHERE id = $1 AND company_id = $2 FOR UPDATE',
    [input.loanId, actor.companyId],
  );
  const loan = rows[0];
  if (!loan) throw notFound();
  const outstanding = loan.qty - loan.returned_qty - loan.lost_qty;
  if (loan.status !== 'OPEN' || outstanding <= 0) throw conflict('LOAN_CLOSED', '이미 종료된 대여입니다.');
  if (input.qty > outstanding) throw conflict('EXCEEDS_OUTSTANDING', `미반납 수량(${outstanding}개)보다 많습니다.`);
  const returned = loan.returned_qty + (input.action === 'RETURN' ? input.qty : 0);
  const lost = loan.lost_qty + (input.action === 'LOAN_LOSS' ? input.qty : 0);
  const closed = returned + lost === loan.qty;
  await db.query(
    `UPDATE app.peripheral_loan SET returned_qty = $2, lost_qty = $3, status = $4, closed_at = CASE WHEN $5::boolean THEN now() ELSE NULL END
      WHERE id = $1 AND company_id = $6`,
    [loan.id, returned, lost, closed ? 'CLOSED' : 'OPEN', closed, actor.companyId],
  );
  const onHand = stock.on_hand_qty + (input.action === 'RETURN' ? input.qty : 0);
  const onLoan = stock.on_loan_qty - input.qty;
  await setQty(db, actor, stock.id, onHand, onLoan);
  await writeTxn(db, actor, stock.id, {
    type: input.action, qty: input.action === 'RETURN' ? input.qty : -input.qty, personId: loan.person_id, loanId: loan.id, note: input.note,
  });
  await evaluateForModel(db, actor.companyId, stock.model_id);
  return { stockId: stock.id, loanId: loan.id, onHandQty: onHand, onLoanQty: onLoan };
}

// ─────────────────────────── 조정·폐기 ───────────────────────────

export type AdjustInput =
  | { action: 'ADJUST'; stockId: string; countedQty: number; note: string }
  | { action: 'DISPOSE'; stockId: string; qty: number; note: string };

/** 실사 조정(센 수량으로 맞춘다)과 폐기. 사유(note)가 필수이고 감사 로그에도 남긴다. */
export async function adjustStock(db: Db, actor: Actor, access: DataAccess, input: AdjustInput): Promise<{ stockId: string; onHandQty: number }> {
  const stock = await lockStock(db, actor, access, input.stockId);
  let onHand: number;
  let delta: number;
  if (input.action === 'ADJUST') {
    onHand = input.countedQty;
    if (onHand + stock.on_loan_qty > MAX_QTY) throw tooMany();
    delta = onHand - stock.on_hand_qty;
    if (delta === 0) throw conflict('NO_CHANGE', '현재 수량과 같습니다.');
  } else {
    if (stock.on_hand_qty < input.qty) throw shortage(stock.on_hand_qty);
    delta = -input.qty;
    onHand = stock.on_hand_qty + delta;
  }
  await setQty(db, actor, stock.id, onHand, stock.on_loan_qty);
  await writeTxn(db, actor, stock.id, { type: input.action, qty: delta, note: input.note });
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: input.action === 'ADJUST' ? 'PERIPHERAL_ADJUSTED' : 'PERIPHERAL_DISPOSED',
    resource: 'peripheral.adjust', targetId: stock.id,
    before: { onHandQty: stock.on_hand_qty }, after: { onHandQty: onHand, note: input.note }, ip: actor.auditIp,
  });
  await evaluateForModel(db, actor.companyId, stock.model_id);
  return { stockId: stock.id, onHandQty: onHand };
}

// ─────────────────────────── 대여 현황 ───────────────────────────

const SQL_LOAN_FROM =
  ' FROM app.peripheral_loan l' +
  ' JOIN app.peripheral_stock s ON s.id = l.stock_id AND s.company_id = l.company_id' +
  ' JOIN app.item_model m ON m.id = s.model_id AND m.company_id = l.company_id' +
  ' JOIN app.department d ON d.id = s.department_id AND d.company_id = l.company_id' +
  ' JOIN app.person p ON p.id = l.person_id AND p.company_id = l.company_id' +
  ' WHERE l.company_id = $1 AND ($2::uuid[] IS NULL OR s.department_id = ANY($2))' +
  ' AND ($3::text IS NULL OR l.status = $3)' +
  ' AND ($4::uuid IS NULL OR l.person_id = $4)' +
  ' AND ($5::uuid IS NULL OR s.department_id = $5)' +
  " AND (NOT $6::boolean OR (l.status = 'OPEN' AND l.due_date < current_date))" +
  ' AND ($7::text IS NULL OR p.name ILIKE $7 OR m.name ILIKE $7 OR m.manufacturer ILIKE $7)';
const SQL_LOAN_COUNT = 'SELECT count(*)::int AS n' + SQL_LOAN_FROM;
const SQL_LOAN_PAGE =
  'SELECT l.id, l.stock_id, s.model_id, m.manufacturer, m.name AS model_name, s.department_id, d.name AS department_name,' +
  ' l.person_id, p.name AS person_name, p.is_active AS person_active, l.qty, l.returned_qty, l.lost_qty,' +
  ' (l.qty - l.returned_qty - l.lost_qty) AS outstanding_qty, l.due_date::text AS due_date, l.status, l.loaned_at, l.closed_at,' +
  " (l.status = 'OPEN' AND l.due_date < current_date) AS overdue" +
  SQL_LOAN_FROM +
  ' ORDER BY (l.status = \'OPEN\') DESC, l.due_date ASC NULLS LAST, l.loaned_at DESC, l.id LIMIT $8 OFFSET $9';

export interface LoanListQuery {
  status?: 'OPEN' | 'CLOSED';
  personId?: string;
  departmentId?: string;
  overdue?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}

/** 대여 현황. 기본은 미반납(OPEN)만. */
export async function listLoans(db: Db, actor: Actor, access: DataAccess, query: LoanListQuery) {
  const { page, pageSize, offset } = paging(query);
  const q = query.q?.trim();
  const filters = [actor.companyId, access.scope, query.status ?? null, query.personId ?? null, query.departmentId ?? null, query.overdue ?? false, q ? likePattern(q) : null];
  const count = await db.query<{ n: number }>(SQL_LOAN_COUNT, filters);
  const rows = await db.query(SQL_LOAN_PAGE, [...filters, pageSize, offset]);
  return { total: count.rows[0]?.n ?? 0, page, pageSize, items: rows.rows };
}
