// 기준 정보: 부서·카테고리·모델·직원·사용자 지정 필드. 실제 라우트 핸들러를 실제 PostgreSQL 에 대고 호출한다.
// 각 리소스마다: 정상 흐름, 권한 없음(403), 로그인 없음(401), 다른 기업 ID(404, 변경 없음),
// 다른 기업 데이터 참조 불가(400), 업무 규칙, 동시 중복 생성(201 하나 + 409, 500 없음)을 확인한다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as assetsCreate } from '@/app/api/assets/route';
import { POST as deptActivate } from '@/app/api/departments/[id]/activate/route';
import { POST as deptDeactivate } from '@/app/api/departments/[id]/deactivate/route';
import { DELETE as deptDelete, PATCH as deptPatch } from '@/app/api/departments/[id]/route';
import { GET as deptList, POST as deptCreate } from '@/app/api/departments/route';
import { POST as catActivate } from '@/app/api/master/categories/[id]/activate/route';
import { POST as catDeactivate } from '@/app/api/master/categories/[id]/deactivate/route';
import { DELETE as catDelete, PATCH as catPatch } from '@/app/api/master/categories/[id]/route';
import { GET as catList, POST as catCreate } from '@/app/api/master/categories/route';
import { DELETE as cfDelete, PATCH as cfPatch } from '@/app/api/master/custom-fields/[id]/route';
import { GET as cfList, POST as cfCreate } from '@/app/api/master/custom-fields/route';
import { POST as modelActivate } from '@/app/api/master/models/[id]/activate/route';
import { POST as modelDeactivate } from '@/app/api/master/models/[id]/deactivate/route';
import { DELETE as modelDelete, PATCH as modelPatch } from '@/app/api/master/models/[id]/route';
import { GET as modelList, POST as modelCreate } from '@/app/api/master/models/route';
import { POST as personActivate } from '@/app/api/master/persons/[id]/activate/route';
import { POST as personAnonymize } from '@/app/api/master/persons/[id]/anonymize/route';
import { POST as personDeactivate } from '@/app/api/master/persons/[id]/deactivate/route';
import { PATCH as personPatch } from '@/app/api/master/persons/[id]/route';
import { GET as personList, POST as personCreate } from '@/app/api/master/persons/route';
import { closePool } from '@/lib/db/pool';
import { call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
type Row = Record<string, unknown>;

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};

const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });
const one = async (sql: string, params: unknown[]): Promise<Row | undefined> => (await (await owner()).query(sql, params)).rows[0];
const insertId = async (sql: string, params: unknown[]): Promise<string> => (await (await owner()).query(sql, params)).rows[0].id as string;
const get = (h: Handler, as: string, path = '/') => call(h, { cookie: cookie[as], path });
const post = (h: Handler, as: string, body?: unknown) => call(h, { method: 'POST', cookie: cookie[as], body });
const postId = (h: Handler, as: string, target: string, body?: unknown) => call(withId(h, target), { method: 'POST', cookie: cookie[as], body });
const patchId = (h: Handler, as: string, target: string, body: unknown) => call(withId(h, target), { method: 'PATCH', cookie: cookie[as], body });
const delId = (h: Handler, as: string, target: string) => call(withId(h, target), { method: 'DELETE', cookie: cookie[as] });
const auditActions = async (targetId: string): Promise<string[]> =>
  (await (await owner()).query('SELECT action FROM app.audit_log WHERE target_id = $1 ORDER BY id', [targetId])).rows.map((r) => r.action as string);
const sortedStatuses = (rs: { status: number }[]) => rs.map((r) => r.status).sort((a, b) => a - b);

async function userWithRole(c: TestCompany, loginId: string, roleName: string | null, deptIds: string[] = []): Promise<void> {
  const o = await owner();
  const userId = await makeUser(c.id, loginId, 'COMPANY_USER');
  if (roleName) {
    const role = (await o.query('SELECT id FROM app.role WHERE company_id = $1 AND name = $2', [c.id, roleName])).rows[0].id;
    await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [userId, role, c.id]);
  }
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [userId, d, c.id]);
  cookie[loginId] = await sessionFor(c.code, loginId);
}

/** 기업마다 기본 데이터: 기본 부서(IT), HR, 자산·주변기기 카테고리와 모델 하나씩. */
async function seed(c: TestCompany, p: string): Promise<void> {
  id[`${p}it`] = (await one('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [c.id]))!.id as string;
  id[`${p}hr`] = await insertId("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [c.id]);
  id[`${p}cat`] = await insertId("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'SeedLaptop') RETURNING id", [c.id]);
  id[`${p}pcat`] = await insertId("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'SeedMouse') RETURNING id", [c.id]);
  id[`${p}model`] = await insertId("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'SeedCo', 'A1') RETURNING id", [c.id, id[`${p}cat`]]);
  id[`${p}pmodel`] = await insertId("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'SeedCo', 'P1') RETURNING id", [c.id, id[`${p}pcat`]]);
}

/** 소유자 연결로 자산 한 대를 넣는다(이 파일의 관심사는 기준 정보이므로 자산 API를 거치지 않는다). */
const insertAsset = (companyId: string, modelId: string, departmentId: string, holder: string | null = null, state = holder ? 'IN_USE' : 'IN_STOCK') =>
  insertId(
    `INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate, department_id, holder_person_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [companyId, modelId, uniq('MT-'), state, state === 'IN_STOCK' ? 'AVAILABLE' : null, departmentId, holder],
  );

beforeAll(async () => {
  A = await makeCompany('MSTA');
  B = await makeCompany('MSTB');
  await seed(A, '');
  await seed(B, 'b');
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  await userWithRole(A, 'viewer', 'Viewer'); // 기준 정보 조회만
  await userWithRole(A, 'oper', 'Stock Operator'); // 조회 + 직원 등록·수정
  await userWithRole(A, 'manager', 'Stock Manager'); // 기준 정보 전부
  await userWithRole(A, 'hrmanager', 'Stock Manager', [id.hr!]); // 기준 정보 전부, 부서 범위 HR
  await userWithRole(A, 'plain', null); // 역할 없음
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('로그인 없음', () => {
  it('모든 기준 정보 API는 로그인하지 않으면 401', async () => {
    const x = id.it!;
    const cases: Array<[Handler, string]> = [
      [deptList, 'GET'], [deptCreate, 'POST'], [withId(deptPatch, x), 'PATCH'], [withId(deptDelete, x), 'DELETE'],
      [withId(deptActivate, x), 'POST'], [withId(deptDeactivate, x), 'POST'],
      [catList, 'GET'], [catCreate, 'POST'], [withId(catPatch, x), 'PATCH'], [withId(catDelete, x), 'DELETE'],
      [withId(catActivate, x), 'POST'], [withId(catDeactivate, x), 'POST'],
      [modelList, 'GET'], [modelCreate, 'POST'], [withId(modelPatch, x), 'PATCH'], [withId(modelDelete, x), 'DELETE'],
      [withId(modelActivate, x), 'POST'], [withId(modelDeactivate, x), 'POST'],
      [personList, 'GET'], [personCreate, 'POST'], [withId(personPatch, x), 'PATCH'],
      [withId(personActivate, x), 'POST'], [withId(personDeactivate, x), 'POST'], [withId(personAnonymize, x), 'POST'],
      [cfList, 'GET'], [cfCreate, 'POST'], [withId(cfPatch, x), 'PATCH'], [withId(cfDelete, x), 'DELETE'],
    ];
    for (const [h, method] of cases) {
      const r = await call(h, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      expect(r.status, method).toBe(401);
    }
  });
});

// ─────────────────────────── 부서 ───────────────────────────

describe('부서', () => {
  const newDept = async (name = uniq('Dept')) => {
    const r = await post(deptCreate, 'admin', { name });
    expect(r.status).toBe(201);
    return r.data.departmentId as string;
  };

  it('목록 응답 형식은 그대로다(사용자 관리 화면이 쓴다): 자기 기업 부서만, 정해진 컬럼만, 기본 부서가 먼저', async () => {
    const r = await get(deptList, 'viewer');
    expect(r.status).toBe(200);
    const rows = r.data.departments as Row[];
    expect(rows[0]).toEqual({ id: id.it, name: 'IT', is_default: true, is_active: true });
    for (const d of rows) expect(Object.keys(d).sort()).toEqual(['id', 'is_active', 'is_default', 'name']);
    const ids = rows.map((d) => d.id);
    expect(ids).toContain(id.hr);
    expect(ids).not.toContain(id.bit);
    expect(ids).not.toContain(id.bhr);
  });

  it('등록 → 이름 변경 → 비활성화 → 활성화 → 삭제, 각 단계가 감사 로그에 남는다', async () => {
    const d = await newDept();
    const name = uniq('Renamed');
    expect((await patchId(deptPatch, 'manager', d, { name })).status).toBe(200);
    expect(await one('SELECT name, is_active FROM app.department WHERE id = $1', [d])).toEqual({ name, is_active: true });
    expect((await postId(deptDeactivate, 'manager', d)).status).toBe(200);
    expect((await one('SELECT is_active FROM app.department WHERE id = $1', [d]))!.is_active).toBe(false);
    expect((await postId(deptActivate, 'manager', d)).status).toBe(200);
    expect((await one('SELECT is_active FROM app.department WHERE id = $1', [d]))!.is_active).toBe(true);
    expect((await delId(deptDelete, 'manager', d)).status).toBe(200);
    expect(await one('SELECT 1 FROM app.department WHERE id = $1', [d])).toBeUndefined();
    expect(await auditActions(d)).toEqual(['DEPARTMENT_CREATED', 'DEPARTMENT_UPDATED', 'DEPARTMENT_DEACTIVATED', 'DEPARTMENT_ACTIVATED', 'DEPARTMENT_DELETED']);
  });

  it('권한이 없으면 403, 아무것도 바뀌지 않는다', async () => {
    const d = await newDept();
    expect((await get(deptList, 'plain')).status).toBe(403);
    expect((await post(deptCreate, 'viewer', { name: uniq('X') })).status).toBe(403);
    expect((await post(deptCreate, 'oper', { name: uniq('X') })).status).toBe(403);
    expect((await patchId(deptPatch, 'viewer', d, { name: 'Hacked' })).status).toBe(403);
    expect((await postId(deptDeactivate, 'oper', d)).status).toBe(403);
    expect((await postId(deptActivate, 'viewer', d)).status).toBe(403);
    expect((await delId(deptDelete, 'oper', d)).status).toBe(403);
    expect(await one('SELECT is_active FROM app.department WHERE id = $1', [d])).toEqual({ is_active: true });
  });

  it('부서 범위가 제한된 사용자는 부서 권한이 있어도 부서를 등록·변경할 수 없다', async () => {
    expect((await post(deptCreate, 'hrmanager', { name: uniq('Scoped') })).status).toBe(403);
    expect((await patchId(deptPatch, 'hrmanager', id.hr!, { name: 'HR2' })).status).toBe(403);
    expect((await postId(deptDeactivate, 'hrmanager', id.hr!)).status).toBe(403);
    expect((await one('SELECT name, is_active FROM app.department WHERE id = $1', [id.hr]))).toEqual({ name: 'HR', is_active: true });
    expect((await get(deptList, 'hrmanager')).status).toBe(200);
  });

  it('이름은 기업 안에서 고유하다(대소문자 무시). 다른 기업에서는 같은 이름을 쓸 수 있다', async () => {
    const name = uniq('Sales');
    const d = await newDept(name);
    expect((await post(deptCreate, 'admin', { name: name.toLowerCase() })).status).toBe(409);
    expect((await post(deptCreate, 'admin', { name: `  ${name}  ` })).status).toBe(409); // 앞뒤 공백은 잘라서 비교
    expect((await patchId(deptPatch, 'admin', id.hr!, { name: name.toUpperCase() })).status).toBe(409);
    expect((await patchId(deptPatch, 'admin', d, { name })).status).toBe(200); // 자기 이름 그대로는 허용
    expect((await post(deptCreate, 'badmin', { name })).status).toBe(201);
    expect((await post(deptCreate, 'admin', { name: '   ' })).status).toBe(400);
  });

  it('기본 부서는 비활성화·삭제할 수 없고, 기본 지정을 바꾸는 입력은 받지 않는다', async () => {
    const before = await one('SELECT name, is_default, is_active FROM app.department WHERE id = $1', [id.it]);
    const deact = await postId(deptDeactivate, 'admin', id.it!);
    expect(deact.status).toBe(409);
    expect(deact.data.error.code).toBe('DEFAULT_DEPARTMENT');
    expect((await delId(deptDelete, 'admin', id.it!)).status).toBe(409);
    expect((await patchId(deptPatch, 'admin', id.it!, { isDefault: false })).status).toBe(400);
    expect((await patchId(deptPatch, 'admin', id.it!, { isActive: false })).status).toBe(400);
    expect(await one('SELECT name, is_default, is_active FROM app.department WHERE id = $1', [id.it])).toEqual(before);
  });

  it('어디에서든 참조되는 부서는 삭제할 수 없고(409, 비활성화 안내), 삭제되지 않는다', async () => {
    const o = await owner();
    const refs: Record<string, (d: string) => Promise<unknown>> = {
      asset: (d) => insertAsset(A.id, id.model!, d),
      peripheralStock: (d) => o.query('INSERT INTO app.peripheral_stock (company_id, model_id, department_id) VALUES ($1, $2, $3)', [A.id, id.pmodel, d]),
      person: (d) => o.query("INSERT INTO app.person (company_id, name, department_id) VALUES ($1, 'Ref', $2)", [A.id, d]),
      userScope: (d) => o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) SELECT id, $2, $1 FROM app.app_user WHERE company_id = $1 AND login_id = $3', [A.id, d, 'plain']),
      threshold: (d) => o.query('INSERT INTO app.stock_threshold (company_id, model_id, department_id, min_qty) VALUES ($1, $2, $3, 1)', [A.id, id.pmodel, d]),
      mailSchedule: (d) => o.query("INSERT INTO app.mail_schedule (company_id, name, frequency, content_type, department_id) VALUES ($1, 'm', 'DAILY', 'LOW_STOCK', $2)", [A.id, d]),
      history: async (d) => {
        const asset = await insertAsset(A.id, id.model!, id.it!);
        await o.query("INSERT INTO app.asset_txn (company_id, asset_id, type, from_department_id, to_department_id) VALUES ($1, $2, 'CHANGE_DEPARTMENT', $3, $4)", [A.id, asset, d, id.it]);
      },
    };
    for (const [kind, ref] of Object.entries(refs)) {
      const d = await newDept();
      await ref(d);
      const r = await delId(deptDelete, 'admin', d);
      expect(r.status, kind).toBe(409);
      expect(r.data.error.code, kind).toBe('IN_USE');
      expect(r.data.error.message, kind).toMatch(/비활성화/);
      expect(await one('SELECT 1 AS ok FROM app.department WHERE id = $1', [d]), kind).toEqual({ ok: 1 });
    }
    await o.query("DELETE FROM app.user_department_scope WHERE user_id = (SELECT id FROM app.app_user WHERE company_id = $1 AND login_id = 'plain')", [A.id]);
  });

  it('사용 중인 부서도 비활성화할 수 있고, 비활성 부서는 새 기록(자산·직원)에서 고를 수 없다', async () => {
    const d = await newDept();
    await insertAsset(A.id, id.model!, d);
    expect((await postId(deptDeactivate, 'admin', d)).status).toBe(200);
    expect((await post(personCreate, 'admin', { name: 'NoDept', departmentId: d })).status).toBe(400);
    expect((await post(assetsCreate, 'admin', { modelId: id.model, assetTag: uniq('T-'), departmentId: d })).status).toBe(400);
    expect((await one('SELECT count(*)::int AS n FROM app.asset WHERE department_id = $1', [d]))!.n).toBe(1); // 기존 기록은 그대로
  });

  it('다른 기업 관리자는 ID로 지정해도 404이고, 아무것도 바뀌지 않는다', async () => {
    const d = await newDept();
    const before = await one('SELECT name, is_active FROM app.department WHERE id = $1', [d]);
    expect((await patchId(deptPatch, 'badmin', d, { name: 'Stolen' })).status).toBe(404);
    expect((await postId(deptDeactivate, 'badmin', d)).status).toBe(404);
    expect((await postId(deptActivate, 'badmin', d)).status).toBe(404);
    expect((await delId(deptDelete, 'badmin', d)).status).toBe(404);
    expect(await one('SELECT name, is_active FROM app.department WHERE id = $1', [d])).toEqual(before);
    expect((await get(deptList, 'badmin')).data.departments.map((x: Row) => x.id)).not.toContain(d);
    expect((await patchId(deptPatch, 'admin', 'not-a-uuid', { name: 'x' })).status).toBe(404);
  });

  it('같은 이름을 동시에 등록해도 하나만 만들어지고 500이 나지 않는다', async () => {
    const name = uniq('Race');
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => post(deptCreate, 'admin', { name: i % 2 ? name.toLowerCase() : name })));
    expect(sortedStatuses(rs)).toEqual([201, 409, 409, 409]);
    expect((await one('SELECT count(*)::int AS n FROM app.department WHERE company_id = $1 AND lower(name) = lower($2)', [A.id, name]))!.n).toBe(1);
  });
});

// ─────────────────────────── 카테고리 ───────────────────────────

describe('카테고리', () => {
  const newCat = async (over: Row = {}) => {
    const r = await post(catCreate, 'admin', { kind: 'ASSET', name: uniq('Cat'), ...over });
    expect(r.status).toBe(201);
    return r.data.categoryId as string;
  };
  const listIds = async (path: string, as = 'viewer') => ((await get(catList, as, path)).data.categories as Row[]).map((c) => c.id);

  it('등록 → 수정 → 비활성화(기본 목록에서 빠짐) → 활성화 → 삭제, 감사 로그', async () => {
    const c = await newCat({ kind: 'PERIPHERAL', nameKo: '키보드', nameZh: '键盘', sortOrder: 5 });
    const listed = ((await get(catList, 'viewer', '/api/master/categories?kind=PERIPHERAL')).data.categories as Row[]).find((x) => x.id === c);
    expect(listed).toMatchObject({ kind: 'PERIPHERAL', name_ko: '키보드', name_zh: '键盘', sort_order: 5, is_active: true, model_count: 0 });
    expect(await listIds('/api/master/categories?kind=ASSET')).not.toContain(c);
    expect((await patchId(catPatch, 'manager', c, { name: uniq('Keyboard'), nameZh: null, sortOrder: 1 })).status).toBe(200);
    expect(await one('SELECT name_ko, name_zh, sort_order FROM app.category WHERE id = $1', [c])).toEqual({ name_ko: '키보드', name_zh: null, sort_order: 1 });
    expect((await postId(catDeactivate, 'manager', c)).status).toBe(200);
    expect(await listIds('/api/master/categories')).not.toContain(c);
    expect(await listIds('/api/master/categories?includeInactive=true')).toContain(c);
    expect((await postId(catActivate, 'manager', c)).status).toBe(200);
    expect(await listIds('/api/master/categories')).toContain(c);
    expect((await delId(catDelete, 'manager', c)).status).toBe(200);
    expect(await one('SELECT 1 FROM app.category WHERE id = $1', [c])).toBeUndefined();
    expect(await auditActions(c)).toEqual(['CATEGORY_CREATED', 'CATEGORY_UPDATED', 'CATEGORY_DEACTIVATED', 'CATEGORY_ACTIVATED', 'CATEGORY_DELETED']);
    expect((await get(catList, 'viewer', '/api/master/categories?kind=OTHER')).status).toBe(400);
  });

  it('권한이 없으면 403', async () => {
    const c = await newCat();
    expect((await get(catList, 'plain')).status).toBe(403);
    expect((await post(catCreate, 'viewer', { kind: 'ASSET', name: uniq('X') })).status).toBe(403);
    expect((await patchId(catPatch, 'oper', c, { name: 'x' })).status).toBe(403);
    expect((await postId(catDeactivate, 'oper', c)).status).toBe(403);
    expect((await postId(catActivate, 'viewer', c)).status).toBe(403);
    expect((await delId(catDelete, 'viewer', c)).status).toBe(403);
    expect(await one('SELECT is_active FROM app.category WHERE id = $1', [c])).toEqual({ is_active: true });
  });

  it('이름은 기업 안에서 종류와 관계없이 고유하다(대소문자 무시)', async () => {
    const name = uniq('Monitor');
    const c = await newCat({ name });
    expect((await post(catCreate, 'admin', { kind: 'PERIPHERAL', name: name.toLowerCase() })).status).toBe(409);
    const other = await newCat();
    expect((await patchId(catPatch, 'admin', other, { name: name.toUpperCase() })).status).toBe(409);
    expect((await patchId(catPatch, 'admin', c, { name })).status).toBe(200);
    expect((await post(catCreate, 'badmin', { kind: 'ASSET', name })).status).toBe(201);
  });

  it('모델이 있는 카테고리는 종류를 바꿀 수 없다. 모델이 없으면 바꿀 수 있다', async () => {
    const empty = await newCat();
    expect((await patchId(catPatch, 'admin', empty, { kind: 'PERIPHERAL' })).status).toBe(200);
    expect((await one('SELECT kind FROM app.category WHERE id = $1', [empty]))!.kind).toBe('PERIPHERAL');

    const used = await newCat();
    expect((await post(modelCreate, 'admin', { categoryId: used, manufacturer: 'Acme', name: uniq('M') })).status).toBe(201);
    const r = await patchId(catPatch, 'admin', used, { kind: 'PERIPHERAL', name: uniq('ShouldNotApply') });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('KIND_LOCKED');
    expect((await one('SELECT kind FROM app.category WHERE id = $1', [used]))!.kind).toBe('ASSET');
    // 비활성 모델만 있어도 마찬가지다.
    await (await owner()).query('UPDATE app.item_model SET is_active = false WHERE category_id = $1', [used]);
    expect((await patchId(catPatch, 'admin', used, { kind: 'PERIPHERAL' })).status).toBe(409);
    expect((await patchId(catPatch, 'admin', used, { kind: 'ASSET' })).status).toBe(200); // 같은 값은 변경이 아니다
  });

  it('모델·한계수량이 참조하는 카테고리는 삭제할 수 없다(409, 비활성화 안내)', async () => {
    const withModel = await newCat();
    await post(modelCreate, 'admin', { categoryId: withModel, manufacturer: 'Acme', name: uniq('M') });
    const r = await delId(catDelete, 'admin', withModel);
    expect(r.status).toBe(409);
    expect(r.data.error.message).toMatch(/비활성화/);
    expect(await one('SELECT 1 AS ok FROM app.category WHERE id = $1', [withModel])).toEqual({ ok: 1 });

    const withThreshold = await newCat();
    await (await owner()).query('INSERT INTO app.stock_threshold (company_id, category_id, min_qty) VALUES ($1, $2, 1)', [A.id, withThreshold]);
    expect((await delId(catDelete, 'admin', withThreshold)).status).toBe(409);
    expect(await one('SELECT 1 AS ok FROM app.category WHERE id = $1', [withThreshold])).toEqual({ ok: 1 });
  });

  it('다른 기업 관리자는 ID로 지정해도 404이고, 아무것도 바뀌지 않으며 목록에도 없다', async () => {
    const c = await newCat();
    const before = await one('SELECT kind, name, is_active FROM app.category WHERE id = $1', [c]);
    expect((await patchId(catPatch, 'badmin', c, { name: 'Stolen', kind: 'PERIPHERAL' })).status).toBe(404);
    expect((await postId(catDeactivate, 'badmin', c)).status).toBe(404);
    expect((await postId(catActivate, 'badmin', c)).status).toBe(404);
    expect((await delId(catDelete, 'badmin', c)).status).toBe(404);
    expect(await one('SELECT kind, name, is_active FROM app.category WHERE id = $1', [c])).toEqual(before);
    expect(await listIds('/api/master/categories?includeInactive=true', 'badmin')).not.toContain(c);
  });

  it('같은 이름을 동시에 등록해도 하나만 만들어지고 500이 나지 않는다', async () => {
    const name = uniq('RaceCat');
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => post(catCreate, 'admin', { kind: i % 2 ? 'ASSET' : 'PERIPHERAL', name })));
    expect(sortedStatuses(rs)).toEqual([201, 409, 409, 409]);
  });
});

// ─────────────────────────── 모델 ───────────────────────────

describe('모델', () => {
  const newModel = async (over: Row = {}) => {
    const r = await post(modelCreate, 'admin', { categoryId: id.cat, manufacturer: 'Lenovo', name: uniq('X1-'), ...over });
    expect(r.status).toBe(201);
    return r.data.modelId as string;
  };
  const listIds = async (path: string, as = 'viewer') => ((await get(modelList, as, path)).data.models as Row[]).map((m) => m.id);

  it('종류는 카테고리에서 복사되고 입력으로 받지 않는다', async () => {
    const m = await newModel({ categoryId: id.pcat });
    expect((await one('SELECT kind FROM app.item_model WHERE id = $1', [m]))!.kind).toBe('PERIPHERAL');
    expect((await post(modelCreate, 'admin', { categoryId: id.pcat, kind: 'ASSET', manufacturer: 'x', name: uniq('y') })).status).toBe(400);
    expect((await patchId(modelPatch, 'admin', m, { kind: 'ASSET' })).status).toBe(400);
  });

  it('등록 → 수정 → 같은 종류 카테고리로 이동 → 비활성화 → 활성화 → 삭제, 목록 조건, 감사 로그', async () => {
    const q = uniq('Findme');
    const m = await newModel({ manufacturer: 'Dell', name: q });
    expect(await listIds(`/api/master/models?q=${q.toLowerCase()}`)).toEqual([m]);
    expect(await listIds('/api/master/models?q=%25')).not.toContain(m); // LIKE 문자는 글자 그대로 찾는다
    expect(await listIds(`/api/master/models?categoryId=${id.cat}`)).toContain(m);
    expect(await listIds('/api/master/models?kind=PERIPHERAL')).not.toContain(m);
    const row = ((await get(modelList, 'viewer', `/api/master/models?q=${q}`)).data.models as Row[])[0];
    expect(row).toMatchObject({ id: m, category_id: id.cat, category_name: 'SeedLaptop', kind: 'ASSET', manufacturer: 'Dell', name: q, is_active: true });

    const cat2 = (await post(catCreate, 'admin', { kind: 'ASSET', name: uniq('Desktop') })).data.categoryId as string;
    expect((await patchId(modelPatch, 'manager', m, { categoryId: cat2, name: `${q}-v2` })).status).toBe(200);
    expect(await one('SELECT category_id, name, kind FROM app.item_model WHERE id = $1', [m])).toEqual({ category_id: cat2, name: `${q}-v2`, kind: 'ASSET' });
    expect((await postId(modelDeactivate, 'manager', m)).status).toBe(200);
    expect(await listIds(`/api/master/models?q=${q}`)).toEqual([]);
    expect(await listIds(`/api/master/models?q=${q}&includeInactive=true`)).toEqual([m]);
    expect((await postId(modelActivate, 'manager', m)).status).toBe(200);
    expect((await delId(modelDelete, 'manager', m)).status).toBe(200);
    expect(await one('SELECT 1 FROM app.item_model WHERE id = $1', [m])).toBeUndefined();
    expect(await auditActions(m)).toEqual(['MODEL_CREATED', 'MODEL_UPDATED', 'MODEL_DEACTIVATED', 'MODEL_ACTIVATED', 'MODEL_DELETED']);
  });

  it('종류가 다른 카테고리, 비활성 카테고리, 다른 기업의 카테고리로는 등록·이동할 수 없다(400)', async () => {
    const m = await newModel();
    expect((await patchId(modelPatch, 'admin', m, { categoryId: id.pcat })).status).toBe(400);
    expect((await patchId(modelPatch, 'admin', m, { categoryId: id.bcat })).status).toBe(400);
    expect((await post(modelCreate, 'admin', { categoryId: id.bcat, manufacturer: 'x', name: uniq('y') })).status).toBe(400);
    const off = (await post(catCreate, 'admin', { kind: 'ASSET', name: uniq('Off') })).data.categoryId as string;
    await postId(catDeactivate, 'admin', off);
    expect((await post(modelCreate, 'admin', { categoryId: off, manufacturer: 'x', name: uniq('y') })).status).toBe(400);
    expect((await patchId(modelPatch, 'admin', m, { categoryId: off })).status).toBe(400);
    expect((await one('SELECT category_id FROM app.item_model WHERE id = $1', [m]))!.category_id).toBe(id.cat);
  });

  it('(제조사, 이름)은 기업 안에서 고유하다(대소문자 무시)', async () => {
    const name = uniq('T14-');
    const m = await newModel({ manufacturer: 'Lenovo', name });
    expect((await post(modelCreate, 'admin', { categoryId: id.cat, manufacturer: 'LENOVO', name: name.toLowerCase() })).status).toBe(409);
    expect((await post(modelCreate, 'admin', { categoryId: id.pcat, manufacturer: 'lenovo', name })).status).toBe(409);
    const other = await newModel({ manufacturer: 'HP', name }); // 제조사가 다르면 같은 이름 가능
    expect((await patchId(modelPatch, 'admin', other, { manufacturer: 'lenovo' })).status).toBe(409);
    expect((await patchId(modelPatch, 'admin', m, { name })).status).toBe(200);
    expect((await post(modelCreate, 'badmin', { categoryId: id.bcat, manufacturer: 'Lenovo', name })).status).toBe(201);
  });

  it('자산·주변기기 재고·한계수량이 참조하는 모델은 삭제할 수 없다(409)', async () => {
    const o = await owner();
    const withAsset = await newModel();
    await insertAsset(A.id, withAsset, id.it!);
    const withStock = await newModel({ categoryId: id.pcat });
    await o.query('INSERT INTO app.peripheral_stock (company_id, model_id, department_id) VALUES ($1, $2, $3)', [A.id, withStock, id.it]);
    const withThreshold = await newModel();
    await o.query('INSERT INTO app.stock_threshold (company_id, model_id, min_qty) VALUES ($1, $2, 1)', [A.id, withThreshold]);
    for (const m of [withAsset, withStock, withThreshold]) {
      const r = await delId(modelDelete, 'admin', m);
      expect(r.status).toBe(409);
      expect(r.data.error.message).toMatch(/비활성화/);
      expect(await one('SELECT 1 AS ok FROM app.item_model WHERE id = $1', [m])).toEqual({ ok: 1 });
    }
  });

  it('권한이 없으면 403', async () => {
    const m = await newModel();
    expect((await get(modelList, 'plain')).status).toBe(403);
    expect((await post(modelCreate, 'viewer', { categoryId: id.cat, manufacturer: 'x', name: uniq('y') })).status).toBe(403);
    expect((await patchId(modelPatch, 'oper', m, { name: 'x' })).status).toBe(403);
    expect((await postId(modelDeactivate, 'oper', m)).status).toBe(403);
    expect((await postId(modelActivate, 'viewer', m)).status).toBe(403);
    expect((await delId(modelDelete, 'oper', m)).status).toBe(403);
  });

  it('다른 기업 관리자는 ID로 지정해도 404이고, 아무것도 바뀌지 않으며 목록에도 없다', async () => {
    const m = await newModel();
    const before = await one('SELECT category_id, manufacturer, name, is_active FROM app.item_model WHERE id = $1', [m]);
    expect((await patchId(modelPatch, 'badmin', m, { name: 'Stolen' })).status).toBe(404);
    expect((await patchId(modelPatch, 'badmin', m, { categoryId: id.bcat })).status).toBe(404);
    expect((await postId(modelDeactivate, 'badmin', m)).status).toBe(404);
    expect((await postId(modelActivate, 'badmin', m)).status).toBe(404);
    expect((await delId(modelDelete, 'badmin', m)).status).toBe(404);
    expect(await one('SELECT category_id, manufacturer, name, is_active FROM app.item_model WHERE id = $1', [m])).toEqual(before);
    expect(await listIds('/api/master/models?includeInactive=true', 'badmin')).not.toContain(m);
    expect(await listIds(`/api/master/models?categoryId=${id.cat}`, 'badmin')).toEqual([]);
  });

  it('같은 모델을 동시에 등록해도 하나만 만들어지고 500이 나지 않는다', async () => {
    const name = uniq('RaceM');
    const rs = await Promise.all(Array.from({ length: 4 }, () => post(modelCreate, 'admin', { categoryId: id.cat, manufacturer: 'Race', name })));
    expect(sortedStatuses(rs)).toEqual([201, 409, 409, 409]);
  });
});

// ─────────────────────────── 직원 ───────────────────────────

describe('직원', () => {
  const PERSON_KEYS = ['anonymized_at', 'department_id', 'department_name', 'email', 'employee_no', 'id', 'is_active', 'name'];
  const newPerson = async (over: Row = {}, as = 'admin') => {
    const r = await post(personCreate, as, { name: uniq('Person'), ...over });
    expect(r.status).toBe(201);
    return r.data.personId as string;
  };
  const list = async (path: string, as = 'viewer') => (await get(personList, as, path)).data as { total: number; page: number; pageSize: number; items: Row[] };

  it('등록 → 수정, 응답에는 정해진 컬럼만 있고 부서 이름이 붙는다', async () => {
    const emp = uniq('E');
    const name = uniq('Hong');
    const p = await newPerson({ employeeNo: emp, name, departmentId: id.hr, email: 'hong@example.com' }, 'oper');
    const found = await list(`/api/master/persons?q=${emp}`);
    expect(found.total).toBe(1);
    expect(Object.keys(found.items[0]!).sort()).toEqual(PERSON_KEYS);
    expect(found.items[0]).toMatchObject({ id: p, employee_no: emp, name, department_id: id.hr, department_name: 'HR', email: 'hong@example.com', is_active: true, anonymized_at: null });
    expect((await patchId(personPatch, 'oper', p, { departmentId: null, email: '' })).status).toBe(200);
    expect(await one('SELECT department_id, email, name FROM app.person WHERE id = $1', [p])).toEqual({ department_id: null, email: null, name });
    expect(await auditActions(p)).toEqual(['PERSON_CREATED', 'PERSON_UPDATED']);
    expect((await post(personCreate, 'admin', { name: 'x', email: 'not-an-email' })).status).toBe(400);
  });

  it('검색(이름·사번·이메일), 부서 필터, 비활성 포함, 페이지 나누기', async () => {
    const tagName = uniq('Srch');
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await newPerson({ name: `${tagName}-${i}`, employeeNo: `${tagName}N${i}`, email: `${tagName.toLowerCase()}${i}@corp.test`, departmentId: i < 2 ? id.hr : null }));
    expect((await list(`/api/master/persons?q=${tagName}`)).total).toBe(5);
    expect((await list(`/api/master/persons?q=${tagName}N3`)).items.map((x) => x.id)).toEqual([ids[3]]);
    expect((await list(`/api/master/persons?q=${tagName.toLowerCase()}4@corp`)).items.map((x) => x.id)).toEqual([ids[4]]);
    expect((await list(`/api/master/persons?q=${tagName}&departmentId=${id.hr}`)).total).toBe(2);
    const page2 = await list(`/api/master/persons?q=${tagName}&pageSize=2&page=2`);
    expect(page2).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(page2.items.map((x) => x.id)).toEqual([ids[2], ids[3]]);
    await postId(personDeactivate, 'admin', ids[0]!);
    expect((await list(`/api/master/persons?q=${tagName}`)).total).toBe(4);
    expect((await list(`/api/master/persons?q=${tagName}&includeInactive=true`)).total).toBe(5);
    expect((await get(personList, 'viewer', '/api/master/persons?pageSize=201')).status).toBe(400);
    expect((await get(personList, 'viewer', '/api/master/persons?departmentId=nope')).status).toBe(400);
  });

  it('직원 명부는 부서 범위로 제한하지 않는다', async () => {
    const p = await newPerson({ departmentId: id.it });
    expect((await list('/api/master/persons?pageSize=200&includeInactive=true', 'hrmanager')).items.map((x) => x.id)).toContain(p);
  });

  it('사번은 고유하다(대소문자 무시). 퇴사자의 사번도 다시 쓸 수 없고, 다른 기업에서는 쓸 수 있다', async () => {
    const emp = uniq('emp');
    const p = await newPerson({ employeeNo: emp });
    expect((await post(personCreate, 'admin', { name: 'Dup', employeeNo: emp.toUpperCase() })).status).toBe(409);
    await postId(personDeactivate, 'admin', p);
    expect((await post(personCreate, 'admin', { name: 'Dup', employeeNo: emp })).status).toBe(409);
    const other = await newPerson({ employeeNo: uniq('emp') });
    expect((await patchId(personPatch, 'admin', other, { employeeNo: emp })).status).toBe(409);
    expect((await post(personCreate, 'badmin', { name: 'Other', employeeNo: emp })).status).toBe(201);
    // 사번이 없는 직원은 여럿 있을 수 있다.
    await newPerson();
    await newPerson({ employeeNo: '' });
  });

  it('부서는 자기 기업의 활성 부서만 지정할 수 있다(400)', async () => {
    expect((await post(personCreate, 'admin', { name: 'x', departmentId: id.bhr })).status).toBe(400);
    const p = await newPerson();
    expect((await patchId(personPatch, 'admin', p, { departmentId: id.bit })).status).toBe(400);
    const off = (await post(deptCreate, 'admin', { name: uniq('Closed') })).data.departmentId as string;
    await postId(deptDeactivate, 'admin', off);
    expect((await post(personCreate, 'admin', { name: 'x', departmentId: off })).status).toBe(400);
    expect((await patchId(personPatch, 'admin', p, { departmentId: off })).status).toBe(400);
    expect((await one('SELECT department_id FROM app.person WHERE id = $1', [p]))!.department_id).toBeNull();
  });

  it('자산을 보유하거나(상태 무관) 반납하지 않은 대여가 있으면 퇴사 처리를 거부하고 그 수를 알려 준다', async () => {
    const o = await owner();
    const p = await newPerson();
    await insertAsset(A.id, id.model!, id.it!, p);
    await insertAsset(A.id, id.model!, id.it!, p, 'MAINTENANCE'); // 수리 중에도 보유자는 남는다
    const stock = await insertId('INSERT INTO app.peripheral_stock (company_id, model_id, department_id, on_loan_qty) VALUES ($1, $2, $3, 3) RETURNING id', [A.id, id.pmodel, id.hr]);
    const loan = await insertId('INSERT INTO app.peripheral_loan (company_id, stock_id, person_id, qty) VALUES ($1, $2, $3, 2) RETURNING id', [A.id, stock, p]);
    await o.query("INSERT INTO app.peripheral_loan (company_id, stock_id, person_id, qty, returned_qty, status) VALUES ($1, $2, $3, 1, 1, 'CLOSED')", [A.id, stock, p]);

    const r = await postId(personDeactivate, 'admin', p);
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ error: { code: 'HOLDS_ITEMS' }, holding: { assets: 2, openLoans: 1 } });
    expect(r.data.error.message).toBeTruthy();
    expect((await one('SELECT is_active FROM app.person WHERE id = $1', [p]))!.is_active).toBe(true);

    await o.query("UPDATE app.asset SET state = 'IN_STOCK', substate = 'AVAILABLE', holder_person_id = NULL WHERE holder_person_id = $1", [p]);
    expect((await postId(personDeactivate, 'admin', p)).data.holding).toEqual({ assets: 0, openLoans: 1 });
    await o.query("UPDATE app.peripheral_loan SET returned_qty = qty, status = 'CLOSED' WHERE id = $1", [loan]);
    expect((await postId(personDeactivate, 'admin', p)).status).toBe(200);
    expect((await one('SELECT is_active FROM app.person WHERE id = $1', [p]))!.is_active).toBe(false);
    expect((await postId(personActivate, 'admin', p)).status).toBe(200);
    expect(await auditActions(p)).toEqual(['PERSON_CREATED', 'PERSON_DEACTIVATED', 'PERSON_ACTIVATED']);
  });

  it('익명화: 활성 직원은 거부, 퇴사자는 이름·사번·이메일이 지워지고 감사 로그 어디에도 옛 값이 없다. 되돌릴 수 없다', async () => {
    const name = uniq('SecretName');
    const emp = uniq('SECRETEMP');
    const email = `${uniq('secret').toLowerCase()}@mail.test`;
    const p = await newPerson({ name, employeeNo: emp, email, departmentId: id.hr });
    expect((await patchId(personPatch, 'admin', p, { name: `${name}-2` })).status).toBe(200);
    const active = await postId(personAnonymize, 'admin', p);
    expect(active.status).toBe(409);
    expect((await one('SELECT name FROM app.person WHERE id = $1', [p]))!.name).toBe(`${name}-2`);

    await postId(personDeactivate, 'admin', p);
    expect((await postId(personAnonymize, 'viewer', p)).status).toBe(403);
    expect((await postId(personAnonymize, 'oper', p)).status).toBe(200); // master.person:update
    const row = await one('SELECT name, employee_no, email, department_id, is_active, anonymized_at FROM app.person WHERE id = $1', [p]);
    expect(row).toMatchObject({ name: `퇴사자-${p.slice(0, 8)}`, employee_no: null, email: null, department_id: id.hr, is_active: false });
    expect(row!.anonymized_at).not.toBeNull();

    const audit = await (await owner()).query("SELECT action, coalesce(before::text, '') || coalesce(after::text, '') AS t FROM app.audit_log WHERE company_id = $1", [A.id]);
    expect(audit.rows.some((x) => x.action === 'PERSON_ANONYMIZED')).toBe(true);
    for (const x of audit.rows) {
      expect(x.t).not.toContain(name);
      expect(x.t).not.toContain(emp);
      expect(x.t).not.toContain(email);
    }
    // 응답에서도 옛 값은 보이지 않는다.
    expect(JSON.stringify(await list('/api/master/persons?includeInactive=true&pageSize=200'))).not.toContain(name);

    expect((await postId(personAnonymize, 'admin', p)).status).toBe(409);
    expect((await postId(personActivate, 'admin', p)).status).toBe(409);
    expect((await patchId(personPatch, 'admin', p, { name: 'Back' })).status).toBe(409);
    expect((await one('SELECT name, is_active FROM app.person WHERE id = $1', [p]))).toEqual({ name: `퇴사자-${p.slice(0, 8)}`, is_active: false });
  });

  it('권한이 없으면 403 (재고 담당은 등록·수정만, 퇴사 처리는 못 한다)', async () => {
    const p = await newPerson();
    expect((await get(personList, 'plain')).status).toBe(403);
    expect((await post(personCreate, 'viewer', { name: 'x' })).status).toBe(403);
    expect((await patchId(personPatch, 'viewer', p, { name: 'x' })).status).toBe(403);
    expect((await postId(personDeactivate, 'oper', p)).status).toBe(403);
    expect((await postId(personActivate, 'oper', p)).status).toBe(403);
    expect((await postId(personAnonymize, 'plain', p)).status).toBe(403);
    expect((await one('SELECT is_active FROM app.person WHERE id = $1', [p]))!.is_active).toBe(true);
  });

  it('다른 기업 관리자는 ID로 지정해도 404이고, 아무것도 바뀌지 않으며 목록에도 없다', async () => {
    const name = uniq('Victim');
    const p = await newPerson({ name });
    const inactive = await newPerson();
    await postId(personDeactivate, 'admin', inactive);
    const before = await one('SELECT name, is_active, anonymized_at FROM app.person WHERE id = $1', [p]);
    expect((await patchId(personPatch, 'badmin', p, { name: 'Stolen' })).status).toBe(404);
    expect((await postId(personDeactivate, 'badmin', p)).status).toBe(404);
    expect((await postId(personActivate, 'badmin', inactive)).status).toBe(404);
    expect((await postId(personAnonymize, 'badmin', inactive)).status).toBe(404);
    expect(await one('SELECT name, is_active, anonymized_at FROM app.person WHERE id = $1', [p])).toEqual(before);
    expect(await one('SELECT is_active, anonymized_at FROM app.person WHERE id = $1', [inactive])).toEqual({ is_active: false, anonymized_at: null });
    expect((await list(`/api/master/persons?q=${name}&includeInactive=true`, 'badmin')).total).toBe(0);
    expect((await list(`/api/master/persons?departmentId=${id.hr}`, 'badmin')).total).toBe(0);
  });

  it('같은 사번을 동시에 등록해도 하나만 만들어지고 500이 나지 않는다', async () => {
    const emp = uniq('RACE');
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => post(personCreate, 'admin', { name: `R${i}`, employeeNo: i % 2 ? emp.toLowerCase() : emp })));
    expect(sortedStatuses(rs)).toEqual([201, 409, 409, 409]);
  });
});

// ─────────────────────────── 사용자 지정 필드 ───────────────────────────

describe('사용자 지정 필드', () => {
  const newField = async (over: Row = {}) => {
    const r = await post(cfCreate, 'admin', { key: uniq('f').toLowerCase(), label: 'Field', dataType: 'text', ...over });
    expect(r.status).toBe(201);
    return r.data.fieldId as string;
  };
  const keyOf = async (f: string) => (await one('SELECT key FROM app.custom_field_def WHERE id = $1', [f]))!.key as string;

  it('등록 → 목록 → 수정(라벨·제한·순서·사용 여부) → 삭제, 감사 로그', async () => {
    const f = await newField({ label: 'MAC 주소', dataType: 'text', isRestricted: false, sortOrder: 3 });
    const listed = ((await get(cfList, 'viewer')).data.fields as Row[]).find((x) => x.id === f);
    expect(listed).toMatchObject({ label: 'MAC 주소', data_type: 'text', is_restricted: false, sort_order: 3, is_active: true });
    expect((await patchId(cfPatch, 'manager', f, { label: 'MAC', isRestricted: true, sortOrder: 1, isActive: false })).status).toBe(200);
    expect(await one('SELECT label, is_restricted, sort_order, is_active FROM app.custom_field_def WHERE id = $1', [f])).toEqual({ label: 'MAC', is_restricted: true, sort_order: 1, is_active: false });
    expect((await delId(cfDelete, 'manager', f)).status).toBe(200);
    expect(await one('SELECT 1 FROM app.custom_field_def WHERE id = $1', [f])).toBeUndefined();
    expect(await auditActions(f)).toEqual(['CUSTOM_FIELD_CREATED', 'CUSTOM_FIELD_UPDATED', 'CUSTOM_FIELD_DELETED']);
  });

  it('키 형식을 검사하고, 키와 데이터 형식은 만든 뒤 바꿀 수 없다', async () => {
    for (const key of ['Mac', '1mac', '_mac', 'mac-addr', 'a'.repeat(41), '']) {
      expect((await post(cfCreate, 'admin', { key, label: 'x', dataType: 'text' })).status, key).toBe(400);
    }
    expect((await post(cfCreate, 'admin', { key: uniq('k').toLowerCase(), label: 'x', dataType: 'json' })).status).toBe(400);
    const f = await newField({ dataType: 'number' });
    const key = await keyOf(f);
    expect((await patchId(cfPatch, 'admin', f, { key: `${key}_x` })).status).toBe(400);
    expect((await patchId(cfPatch, 'admin', f, { dataType: 'text' })).status).toBe(400);
    expect((await patchId(cfPatch, 'admin', f, { key, dataType: 'number', label: 'Same' })).status).toBe(200); // 같은 값은 허용
    expect(await one('SELECT key, data_type, label FROM app.custom_field_def WHERE id = $1', [f])).toEqual({ key, data_type: 'number', label: 'Same' });
  });

  it('키는 기업 안에서 고유하다. 다른 기업에서는 같은 키를 쓸 수 있다', async () => {
    const key = uniq('dup').toLowerCase();
    await newField({ key });
    expect((await post(cfCreate, 'admin', { key, label: 'x', dataType: 'date' })).status).toBe(409);
    expect((await post(cfCreate, 'badmin', { key, label: 'x', dataType: 'text' })).status).toBe(201);
  });

  it('값이 저장된 자산이 있으면 삭제할 수 없다(409, 사용 안 함 안내). 사용 안 함으로는 바꿀 수 있다', async () => {
    const f = await newField();
    const key = await keyOf(f);
    const asset = await insertAsset(A.id, id.model!, id.it!);
    await (await owner()).query('UPDATE app.asset SET custom = jsonb_build_object($2::text, $3::text) WHERE id = $1', [asset, key, 'v']);
    const r = await delId(cfDelete, 'admin', f);
    expect(r.status).toBe(409);
    expect(r.data.error.message).toMatch(/is_active=false/);
    expect(await one('SELECT 1 AS ok FROM app.custom_field_def WHERE id = $1', [f])).toEqual({ ok: 1 });
    expect((await patchId(cfPatch, 'admin', f, { isActive: false })).status).toBe(200);
    // 다른 기업 자산에 같은 키의 값이 있어도 이 기업의 삭제에는 영향이 없다.
    const bKey = uniq('bk').toLowerCase();
    const bf = (await post(cfCreate, 'badmin', { key: bKey, label: 'x', dataType: 'text' })).data.fieldId as string;
    const af = await newField({ key: bKey });
    const bAsset = await insertAsset(B.id, id.bmodel!, id.bit!);
    await (await owner()).query('UPDATE app.asset SET custom = jsonb_build_object($2::text, 1) WHERE id = $1', [bAsset, bKey]);
    expect((await delId(cfDelete, 'admin', af)).status).toBe(200);
    expect((await delId(cfDelete, 'badmin', bf)).status).toBe(409);
  });

  it('권한이 없으면 403', async () => {
    const f = await newField();
    expect((await get(cfList, 'plain')).status).toBe(403);
    expect((await post(cfCreate, 'oper', { key: uniq('k').toLowerCase(), label: 'x', dataType: 'text' })).status).toBe(403);
    expect((await patchId(cfPatch, 'viewer', f, { label: 'x' })).status).toBe(403);
    expect((await delId(cfDelete, 'oper', f)).status).toBe(403);
    expect((await one('SELECT label FROM app.custom_field_def WHERE id = $1', [f]))!.label).toBe('Field');
  });

  it('다른 기업 관리자는 ID로 지정해도 404이고, 아무것도 바뀌지 않으며 목록에도 없다', async () => {
    const f = await newField();
    expect((await patchId(cfPatch, 'badmin', f, { label: 'Stolen', isRestricted: true })).status).toBe(404);
    expect((await delId(cfDelete, 'badmin', f)).status).toBe(404);
    expect(await one('SELECT label, is_restricted FROM app.custom_field_def WHERE id = $1', [f])).toEqual({ label: 'Field', is_restricted: false });
    expect(((await get(cfList, 'badmin')).data.fields as Row[]).map((x) => x.id)).not.toContain(f);
  });

  it('같은 키를 동시에 등록해도 하나만 만들어지고 500이 나지 않는다', async () => {
    const key = uniq('race').toLowerCase();
    const rs = await Promise.all(Array.from({ length: 4 }, () => post(cfCreate, 'admin', { key, label: 'x', dataType: 'text' })));
    expect(sortedStatuses(rs)).toEqual([201, 409, 409, 409]);
  });
});
