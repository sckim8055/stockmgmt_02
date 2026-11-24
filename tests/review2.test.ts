// 2단계 독립 보안 검토(review2)에서 찾은 결함을 재현하는 테스트.
// 각 테스트는 "있어야 할 안전한 동작"을 기대한다. 실패하면 결함이 다시 생겼다는 뜻이다.
// 아래쪽 '검증되지 않던 보장'은 검토의 변이 테스트에서 살아남은 항목을 메운 것이다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as assignRoute } from '@/app/api/assets/[id]/assign/route';
import { GET as historyRoute } from '@/app/api/assets/[id]/history/route';
import { POST as maintainRoute } from '@/app/api/assets/[id]/maintain/route';
import { POST as retireRoute } from '@/app/api/assets/[id]/retire/route';
import { GET as assetGet, PATCH as assetPatch } from '@/app/api/assets/[id]/route';
import { GET as assetsList, POST as assetsCreate } from '@/app/api/assets/route';
import { PATCH as rolePatch } from '@/app/api/admin/roles/[id]/route';
import { PATCH as customFieldPatch } from '@/app/api/master/custom-fields/[id]/route';
import { POST as anonymizeRoute } from '@/app/api/master/persons/[id]/anonymize/route';
import { POST as deactivatePerson } from '@/app/api/master/persons/[id]/deactivate/route';
import { GET as personsList } from '@/app/api/master/persons/route';
import { POST as departmentCreate } from '@/app/api/departments/route';
import { closePool } from '@/lib/db/pool';
import { call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};

type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });
const one = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];
const tag = () => uniq('R2-');

async function role(name: string, acl: [string, string][]): Promise<string> {
  const o = await owner();
  const roleId = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [A.id, name])).rows[0].id as string;
  for (const [r, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [roleId, r, op]);
  return roleId;
}

async function user(loginId: string, roleIds: string[], deptIds: string[] = []): Promise<void> {
  const o = await owner();
  const userId = await makeUser(A.id, loginId, 'COMPANY_USER');
  for (const r of roleIds) await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [userId, r, A.id]);
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [userId, d, A.id]);
  cookie[loginId] = await sessionFor(A.code, loginId);
}

const roleNamed = async (name: string) => (await one('SELECT id FROM app.role WHERE company_id = $1 AND name = $2', [A.id, name])).id as string;

async function create(as: string, over: Record<string, unknown> = {}) {
  return call(assetsCreate, { method: 'POST', cookie: cookie[as], body: { modelId: id.model, assetTag: tag(), ...over } });
}
const act = (route: Handler, as: string, assetId: string, body: Record<string, unknown>) =>
  call(withId(route, assetId), { method: 'POST', cookie: cookie[as], body });

beforeAll(async () => {
  A = await makeCompany('RVTWO');
  const o = await owner();
  const q = async (sql: string, p: unknown[]) => (await o.query(sql, p)).rows[0].id as string;
  id.it = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A.id])).rows[0].id;
  id.hr = await q("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [A.id]);
  const cat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [A.id]);
  id.model = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Lenovo', 'X1') RETURNING id", [A.id, cat]);
  id.p1 = await q("INSERT INTO app.person (company_id, employee_no, name) VALUES ($1, 'E1', 'Kim Cheolsu') RETURNING id", [A.id]);
  id.cfRestricted = await q(
    "INSERT INTO app.custom_field_def (company_id, key, label, data_type, is_restricted) VALUES ($1, 'cost_center', 'Cost center', 'text', true) RETURNING id",
    [A.id],
  );
  cookie.admin = await sessionFor(A.code, 'admin');
  await user('oper', [await roleNamed('Stock Operator')]);
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('제한 필드: 사용자 지정 필드의 제한 해제', () => {
  it('master.custom_field:update 만 가진 사용자는 제한 필드를 일반 필드로 바꿔 값을 볼 수 없어야 한다', async () => {
    const editor = await role('CF Editor', [
      ['asset.item', 'read'],
      ['master.custom_field', 'read'],
      ['master.custom_field', 'update'],
    ]);
    await user('cfeditor', [editor]);
    const assetId = (await create('admin', { custom: { cost_center: 'CC-SECRET-77' } })).data.assetId as string;

    // 처음에는 보이지 않는다(정상).
    const before = (await call(withId(assetGet, assetId), { cookie: cookie.cfeditor })).data.asset;
    expect(before.custom).toEqual({});

    // 제한 필드 읽기 권한이 없는 사람이 제한을 풀 수 있으면 안 된다.
    const flip = await call(withId(customFieldPatch, id.cfRestricted!), { method: 'PATCH', cookie: cookie.cfeditor, body: { isRestricted: false } });
    const after = (await call(withId(assetGet, assetId), { cookie: cookie.cfeditor })).data.asset;
    // 원상 복구(다른 테스트에 영향이 없게)
    await (await owner()).query('UPDATE app.custom_field_def SET is_restricted = true WHERE id = $1', [id.cfRestricted]);

    expect(JSON.stringify(after), `flip status=${flip.status}`).not.toContain('CC-SECRET-77');
    expect(flip.status).toBe(403);
  });
});

describe('권한 상승: 역할 수정으로 범위 밖 계정의 권한을 넓힘', () => {
  it('HR 범위의 역할 관리자는, 범위가 더 넓은 계정이 쓰는 역할에 권한을 넣어 그 계정의 권한을 넓힐 수 없어야 한다', async () => {
    // 역할 관리자: HR 범위, 폐기 권한 보유
    const roleAdmin = await role('HR Role Admin', [
      ['admin.role', 'read'],
      ['admin.role', 'update'],
      ['asset.item', 'read'],
      ['asset.retire', 'execute'],
    ]);
    await user('hrroleadmin', [roleAdmin], [id.hr!]);
    // 범위 제한 없는 사용자 U 는 조회 역할만 갖는다. U 는 hrroleadmin 이 관리할 수 없는 계정이다(범위가 더 넓다).
    const small = await role('Small Viewer', [['asset.item', 'read']]);
    await user('wide', [small]);
    const itAsset = (await create('admin', { departmentId: id.it })).data.assetId as string;
    expect((await act(retireRoute, 'wide', itAsset, { action: 'RETIRE' })).status).toBe(403);

    const edit = await call(withId(rolePatch, small), {
      method: 'PATCH',
      cookie: cookie.hrroleadmin,
      body: { acl: [{ resource: 'asset.item', operation: 'read' }, { resource: 'asset.retire', operation: 'execute' }] },
    });
    const retire = await act(retireRoute, 'wide', itAsset, { action: 'RETIRE' });
    // HR 범위 담당자의 조작으로 IT 자산이 퇴역되면 안 된다.
    expect({ edit: edit.status, retire: retire.status }).toEqual({ edit: 403, retire: 403 });
  });
});

describe('상태 전이', () => {
  it('사용 중 자산은 수리 입고를 거쳐도 반납 없이 퇴역되면 안 된다(보유자가 이력 없이 사라짐)', async () => {
    const a = (await create('admin')).data.assetId as string;
    expect((await act(assignRoute, 'admin', a, { action: 'ASSIGN', holderPersonId: id.p1 })).status).toBe(200);
    expect((await act(maintainRoute, 'admin', a, { action: 'REPAIR_IN' })).status).toBe(200);
    const retire = await act(retireRoute, 'admin', a, { action: 'RETIRE' });
    const row = await one('SELECT state, holder_person_id FROM app.asset WHERE id = $1', [a]);
    const returned = await one("SELECT count(*)::int AS n FROM app.asset_txn WHERE asset_id = $1 AND type = 'RETURN'", [a]);
    expect({ retire: retire.status, state: row.state }, `returns=${returned.n}`).toEqual({ retire: 409, state: 'MAINTENANCE' });
  });

  it('한 번이라도 사용된 자산은 등록 취소(VOID)할 수 없어야 한다(transitions.ts 주석의 규칙)', async () => {
    const a = (await create('admin')).data.assetId as string;
    await act(assignRoute, 'admin', a, { action: 'ASSIGN', holderPersonId: id.p1 });
    await act(assignRoute, 'admin', a, { action: 'RETURN' });
    const v = await act(retireRoute, 'admin', a, { action: 'VOID' });
    expect(v.status).toBe(409);
    // VOID 되면 기본 목록에서 사라진다.
    const list = await call(assetsList, { cookie: cookie.admin, path: '/api/assets?pageSize=200' });
    expect(list.data.items.map((x: { id: string }) => x.id)).toContain(a);
  });
});

describe('입력 검증: 클라이언트가 500을 낼 수 있음', () => {
  it('달력에 없는 날짜(형식만 맞는 날짜)는 400이어야 한다', async () => {
    expect((await create('admin', { purchaseDate: '2024-02-30' })).status).toBe(400);
    expect((await create('admin', { warrantyEnd: '2024-13-01' })).status).toBe(400);
    const a = (await create('admin')).data.assetId as string;
    expect((await call(withId(assetPatch, a), { method: 'PATCH', cookie: cookie.admin, body: { warrantyEnd: '0000-01-01' } })).status).toBe(400);
    expect((await act(assignRoute, 'admin', a, { action: 'LOAN', holderPersonId: id.p1, dueDate: '2025-02-31' })).status).toBe(400);
  });

  it('NUL 문자가 든 입력은 400이어야 한다', async () => {
    expect((await create('admin', { assetTag: 'A\u0000B' })).status).toBe(400);
    expect((await call(assetsList, { cookie: cookie.admin, path: '/api/assets?q=%00' })).status).toBe(400);
    expect((await call(personsList, { cookie: cookie.admin, path: '/api/master/persons?q=%00' })).status).toBe(400);
    expect((await call(departmentCreate, { method: 'POST', cookie: cookie.admin, body: { name: 'X\u0000' } })).status).toBe(400);
  });
});

describe('직원 익명화', () => {
  it('되돌릴 수 없는 익명화는 퇴사 처리 권한이 없는 재고 담당(Stock Operator)이 할 수 없어야 한다', async () => {
    const o = await owner();
    const p = (await o.query("INSERT INTO app.person (company_id, name, is_active) VALUES ($1, 'Park Gone', false) RETURNING id", [A.id])).rows[0].id as string;
    // 재고 담당은 퇴사 처리(deactivate) 권한이 없다.
    expect((await call(withId(deactivatePerson, p), { method: 'POST', cookie: cookie.oper })).status).toBe(403);
    // 그런데 되돌릴 수 없는 익명화는 할 수 있다(master.person:update 로 묶여 있다).
    expect((await call(withId(anonymizeRoute, p), { method: 'POST', cookie: cookie.oper })).status).toBe(403);
  });

  // 결정: 직접 적어 넣은 글(위치·메모)은 지우지 않는다(이력은 추가만 가능). 화면의 익명화 경고에 이 점을 적었다.
  // 구조화된 값(보유자 이름)은 익명화된다.
  it('익명화 후 이력의 보유자 이름은 익명으로 바뀐다(직접 적은 위치·메모는 남는다)', async () => {
    const o = await owner();
    const p = (await o.query("INSERT INTO app.person (company_id, name) VALUES ($1, 'Choi Minji') RETURNING id", [A.id])).rows[0].id as string;
    const a = (await create('admin')).data.assetId as string;
    // 화면의 처리 대화상자는 메모와 위치를 자유 입력으로 받는다. 보통 이름이 들어간다.
    await act(assignRoute, 'admin', a, { action: 'ASSIGN', holderPersonId: p, location: 'Choi Minji desk', note: 'handed to Choi Minji' });
    await act(assignRoute, 'admin', a, { action: 'RETURN' });
    expect((await call(withId(deactivatePerson, p), { method: 'POST', cookie: cookie.admin })).status).toBe(200);
    expect((await call(withId(anonymizeRoute, p), { method: 'POST', cookie: cookie.admin })).status).toBe(200);
    const h = await call(withId(historyRoute, a), { cookie: cookie.admin });
    const assign = h.data.history.find((x: { type: string }) => x.type === 'ASSIGN');
    expect(assign.to_holder_name).toMatch(/^퇴사자-/);
    const structured = h.data.history.map((x: Record<string, unknown>) => [x.to_holder_name, x.from_holder_name, x.actor_name]);
    expect(JSON.stringify(structured)).not.toContain('Choi Minji');
  });
});

describe('테스트 보강(현재 코드에서는 통과해야 함): 처리 중복 방지를 결정적으로 확인', () => {
  it('같은 자산에 대한 두 배정이 확실히 겹쳐도 한 건만 성공한다', async () => {
    const pg = (await import('pg')).default;
    const a = (await create('admin')).data.assetId as string;
    const p2 = (await (await owner()).query("INSERT INTO app.person (company_id, name) VALUES ($1, 'Second') RETURNING id", [A.id])).rows[0].id as string;
    // 별도 연결로 자산 행을 잠가 두 요청이 모두 같은 지점까지 와서 기다리게 만든다.
    const blocker = new pg.Client({ connectionString: process.env.TEST_OWNER_URL });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM app.asset WHERE id = $1 FOR UPDATE', [a]);
    const p = Promise.all([
      act(assignRoute, 'admin', a, { action: 'ASSIGN', holderPersonId: id.p1 }),
      act(assignRoute, 'admin', a, { action: 'ASSIGN', holderPersonId: p2 }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    await blocker.query('COMMIT');
    await blocker.end();
    const results = await p;
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await one("SELECT count(*)::int AS n FROM app.asset_txn WHERE asset_id = $1 AND type = 'ASSIGN'", [a])).n).toBe(1);
  });
});

describe('검증되지 않던 보장', () => {
  it('상태 전이 표: 상태별로 허용되는 처리가 정확히 이것뿐이다', async () => {
    const { applyAction, ASSET_ACTIONS } = await import('@/lib/assets/transitions');
    type Snap = Parameters<typeof applyAction>[0];
    const allowed = (s: Snap) =>
      ASSET_ACTIONS.filter((a) => {
        try {
          applyAction(s, a, { holderPersonId: 'p', dueDate: '2030-01-01', disposal: 'SOLD' });
          return true;
        } catch {
          return false;
        }
      }).join(' ');
    const snap = (state: string, substate: string | null, holder: string | null = null) => ({ state, substate, holderPersonId: holder }) as Snap;
    expect(allowed(snap('ON_ORDER', null))).toBe('RECEIVE VOID');
    expect(allowed(snap('IN_STOCK', 'AVAILABLE'))).toBe('ASSIGN LOAN RESERVE MARK_DEFECTIVE REPAIR_IN MARK_MISSING RETIRE VOID');
    expect(allowed(snap('IN_STOCK', 'RESERVED'))).toBe('ASSIGN LOAN UNRESERVE MARK_DEFECTIVE REPAIR_IN MARK_MISSING RETIRE');
    expect(allowed(snap('IN_STOCK', 'DEFECTIVE'))).toBe('REPAIR_IN MARK_MISSING RETIRE');
    expect(allowed(snap('IN_USE', null, 'h'))).toBe('RETURN REPAIR_IN MARK_MISSING');
    expect(allowed(snap('MAINTENANCE', null))).toBe('REPAIR_OUT MARK_MISSING RETIRE');
    expect(allowed(snap('MAINTENANCE', null, 'h'))).toBe('REPAIR_OUT MARK_MISSING'); // 보유자가 있으면 퇴역 불가
    expect(allowed(snap('MISSING', null))).toBe('FOUND RETIRE');
    expect(allowed(snap('MISSING', null, 'h'))).toBe('FOUND RETIRE');
    expect(allowed(snap('RETIRED', 'PENDING_DISPOSAL'))).toBe('DISPOSE');
    for (const sub of ['DISPOSED', 'SOLD', 'DONATED']) expect(allowed(snap('RETIRED', sub)), sub).toBe('');
    expect(allowed(snap('VOID', null))).toBe('');
  });

  it('제한 필드의 조회 권한과 수정 권한은 따로 판정된다', async () => {
    const readOnly = await role('Price Reader', [['asset.item', 'read'], ['asset.item', 'update'], ['asset.item.purchase_price', 'read'], ['asset.item.custom_restricted', 'read']]);
    const writeOnly = await role('Price Writer', [['asset.item', 'read'], ['asset.item', 'update'], ['asset.item.purchase_price', 'update'], ['asset.item.custom_restricted', 'update']]);
    await user('preader', [readOnly]);
    await user('pwriter', [writeOnly]);
    const a = (await create('admin', { purchasePrice: 4242, custom: { cost_center: 'CC-RW' } })).data.assetId as string;
    const seenByReader = (await call(withId(assetGet, a), { cookie: cookie.preader })).data.asset;
    expect(seenByReader.purchase_price).toBe(4242);
    expect(seenByReader.custom.cost_center).toBe('CC-RW');
    expect((await call(withId(assetPatch, a), { method: 'PATCH', cookie: cookie.preader, body: { purchasePrice: 1 } })).status).toBe(403);
    expect((await call(withId(assetPatch, a), { method: 'PATCH', cookie: cookie.preader, body: { custom: { cost_center: 'x' } } })).status).toBe(403);
    const seenByWriter = (await call(withId(assetGet, a), { cookie: cookie.pwriter })).data.asset;
    expect('purchase_price' in seenByWriter).toBe(false);
    expect('cost_center' in seenByWriter.custom).toBe(false);
    expect((await call(withId(assetPatch, a), { method: 'PATCH', cookie: cookie.pwriter, body: { purchasePrice: 99 } })).status).toBe(200);
    expect((await one('SELECT purchase_price::float8 AS p FROM app.asset WHERE id = $1', [a])).p).toBe(99);
  });

  it('사용 안 함으로 바꾼 사용자 지정 필드의 값은 응답에서 빠진다(제한 필드 포함)', async () => {
    const o = await owner();
    const defId = (await o.query("INSERT INTO app.custom_field_def (company_id, key, label, data_type, is_restricted) VALUES ($1, 'old_secret', 'Old', 'text', true) RETURNING id", [A.id])).rows[0].id;
    const a = (await create('admin', { custom: { old_secret: 'HIDE-ME' } })).data.assetId as string;
    expect((await call(withId(assetGet, a), { cookie: cookie.admin })).data.asset.custom.old_secret).toBe('HIDE-ME');
    await o.query('UPDATE app.custom_field_def SET is_active = false WHERE id = $1', [defId]);
    expect(JSON.stringify((await call(withId(assetGet, a), { cookie: cookie.admin })).data)).not.toContain('HIDE-ME');
    expect(JSON.stringify((await call(assetsList, { cookie: cookie.admin, path: '/api/assets?pageSize=200' })).data)).not.toContain('HIDE-ME');
  });

  it('값이 남아 있는 키는 일반(비제한) 필드로 다시 만들 수 없다', async () => {
    const { POST: customFieldCreate } = await import('@/app/api/master/custom-fields/route');
    const o = await owner();
    const a = (await create('admin')).data.assetId as string;
    await o.query(`UPDATE app.asset SET custom = custom || '{"ghost_key":"LEFTOVER"}' WHERE id = $1`, [a]);
    const body = { key: 'ghost_key', label: 'Ghost', dataType: 'text' };
    expect((await call(customFieldCreate, { method: 'POST', cookie: cookie.admin, body })).status).toBe(409);
    expect((await call(customFieldCreate, { method: 'POST', cookie: cookie.admin, body: { ...body, isRestricted: true } })).status).toBe(201);
  });

  it('제한 여부는 제한 필드 권한이 있으면 바꿀 수 있고, 권한이 없어도 다른 항목은 고칠 수 있다', async () => {
    const o = await owner();
    const defId = (await o.query("INSERT INTO app.custom_field_def (company_id, key, label, data_type, is_restricted) VALUES ($1, 'flag_test', 'Flag', 'text', false) RETURNING id", [A.id])).rows[0].id as string;
    const patch = (as: string, body: Record<string, unknown>) => call(withId(customFieldPatch, defId), { method: 'PATCH', cookie: cookie[as], body });
    expect((await patch('cfeditor', { isRestricted: true })).status).toBe(403); // 방향과 무관하게 막는다
    expect((await patch('cfeditor', { label: 'Flag 2', isRestricted: false })).status).toBe(200); // 같은 값은 변경이 아니다
    expect((await patch('admin', { isRestricted: true })).status).toBe(200);
    expect((await one('SELECT label, is_restricted FROM app.custom_field_def WHERE id = $1', [defId]))).toEqual({ label: 'Flag 2', is_restricted: true });
  });

  it('범위가 제한된 역할 관리자는, 범위가 더 넓은 계정이 쓰는 역할을 끄거나 지울 수도 없다', async () => {
    const { DELETE: roleDelete } = await import('@/app/api/admin/roles/[id]/route');
    const shared = await role('Shared Small', [['asset.item', 'read']]);
    const editorRole = await role('Scoped Role Admin', [['asset.item', 'read'], ['admin.role', 'read'], ['admin.role', 'update'], ['admin.role', 'delete']]);
    await user('scopedroleadmin', [editorRole], [id.hr!]);
    await user('widereader', [shared]);
    expect((await call(withId(rolePatch, shared), { method: 'PATCH', cookie: cookie.scopedroleadmin, body: { isActive: false } })).status).toBe(403);
    expect((await call(withId(roleDelete as Handler, shared), { method: 'DELETE', cookie: cookie.scopedroleadmin })).status).toBe(403);
    expect((await one('SELECT is_active FROM app.role WHERE id = $1', [shared])).is_active).toBe(true);
    // 아무도 쓰지 않는 역할, 또는 자기 범위 안의 계정만 쓰는 역할은 고칠 수 있다.
    const unused = await role('Unused Small', [['asset.item', 'read']]);
    expect((await call(withId(rolePatch, unused), { method: 'PATCH', cookie: cookie.scopedroleadmin, body: { description: 'ok' } })).status).toBe(200);
    // 관리자는 제한 없이 고친다.
    expect((await call(withId(rolePatch, shared), { method: 'PATCH', cookie: cookie.admin, body: { description: 'by admin' } })).status).toBe(200);
  });

  it('바꿀 내용이 없는 수정 요청은 이력을 남기지 않는다', async () => {
    const a = (await create('admin')).data.assetId as string;
    expect((await call(withId(assetPatch, a), { method: 'PATCH', cookie: cookie.admin, body: {} })).status).toBe(200);
    expect((await one("SELECT count(*)::int AS n FROM app.asset_txn WHERE asset_id = $1 AND type = 'UPDATE'", [a])).n).toBe(0);
  });
});
