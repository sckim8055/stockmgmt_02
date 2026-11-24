// 기업 격리(DB 수준). 서버 코드가 기업 조건을 빠뜨려도 DB가 막는지 확인한다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/lib/db/context';
import { closePool, getPool } from '@/lib/db/pool';
import { closeOwner, makeCompany, makeUser, owner, sessionFor, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
let bDept: string;
let bModel: string;

beforeAll(async () => {
  A = await makeCompany('ISOA');
  B = await makeCompany('ISOB');
  const o = await owner();
  bDept = (await o.query('SELECT id FROM app.department WHERE company_id = $1', [B.id])).rows[0].id;
  const cat = await o.query("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [B.id]);
  bModel = (
    await o.query(
      "INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Lenovo', 'X1') RETURNING id",
      [B.id, cat.rows[0]!.id],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await closeOwner();
  await closePool();
});

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

describe('기업 격리 (RLS)', () => {
  it('기업 조건 없이 조회해도 자기 기업 행만 나온다', async () => {
    const rows = await withTenant(A.id, async (db) => (await db.query('SELECT company_id FROM app.department')).rows);
    expect(rows.length).toBe(1);
    expect(rows[0]!.company_id).toBe(A.id);
  });

  it('다른 기업 행을 ID로 직접 조회해도 나오지 않는다', async () => {
    const rows = await withTenant(A.id, async (db) => (await db.query('SELECT 1 FROM app.department WHERE id = $1', [bDept])).rows);
    expect(rows).toEqual([]);
  });

  it('다른 기업 행은 수정·삭제되지 않는다(영향 0건)', async () => {
    const upd = await withTenant(A.id, async (db) => (await db.query("UPDATE app.department SET name = 'HACKED' WHERE id = $1", [bDept])).rowCount);
    const del = await withTenant(A.id, async (db) => (await db.query('DELETE FROM app.item_model WHERE id = $1', [bModel])).rowCount);
    expect(upd).toBe(0);
    expect(del).toBe(0);
    const o = await owner();
    expect((await o.query('SELECT name FROM app.department WHERE id = $1', [bDept])).rows[0].name).toBe('IT');
  });

  it('다른 기업의 company_id 로 행을 넣을 수 없다', async () => {
    const r = await code(withTenant(A.id, (db) => db.query("INSERT INTO app.department (company_id, name) VALUES ($1, 'Planted')", [B.id])));
    expect(r).toBe('42501'); // RLS WITH CHECK 위반
  });

  it('자기 행의 company_id 를 다른 기업으로 바꿀 수 없다', async () => {
    const r = await code(withTenant(A.id, (db) => db.query('UPDATE app.department SET company_id = $1', [B.id])));
    expect(r).toBe('42501');
  });

  it('다른 기업의 모델을 참조하는 자산을 만들 수 없다(복합 외래키)', async () => {
    const r = await code(
      withTenant(A.id, (db) =>
        db.query("INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate) VALUES ($1, $2, 'T-1', 'IN_STOCK', 'AVAILABLE')", [A.id, bModel]),
      ),
    );
    expect(r).toBe('23503'); // 외래키 위반
  });

  it('기업 문맥을 설정하지 않은 연결에서는 아무 행도 보이지 않는다', async () => {
    const pool = getPool();
    for (const t of ['company', 'app_user', 'department', 'user_session', 'audit_log', 'role_acl']) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM app.${t}`);
      // role_acl 은 시스템 템플릿(공개 읽기)만 보인다.
      if (t === 'role_acl') {
        const o = await owner();
        const tpl = await o.query('SELECT count(*)::int AS n FROM app.role_acl a JOIN app.role r ON r.id = a.role_id WHERE r.company_id IS NULL');
        expect(r.rows[0].n, t).toBe(tpl.rows[0].n);
      } else {
        expect(r.rows[0].n, t).toBe(0);
      }
    }
  });

  it('트랜잭션이 끝나면 기업 문맥이 연결에 남지 않는다', async () => {
    await withTenant(A.id, (db) => db.query('SELECT 1'));
    await withSystem((db) => db.query('SELECT 1'));
    const pool = getPool();
    // 풀의 모든 연결을 확인한다.
    const clients = await Promise.all(Array.from({ length: 5 }, () => pool.connect()));
    try {
      for (const c of clients) {
        const r = await c.query("SELECT coalesce(current_setting('app.company_id', true), '') AS c, coalesce(current_setting('app.system', true), '') AS s");
        expect(r.rows[0].c).toBe('');
        expect(r.rows[0].s).not.toBe('on');
      }
    } finally {
      clients.forEach((c) => c.release());
    }
  });

  it('기업 문맥에서는 다른 기업 계정, 시스템 관리자, 세션이 보이지 않는다', async () => {
    await makeUser(null, `root${Date.now()}`, 'SYSTEM_ADMIN');
    await sessionFor(B.code, B.adminLoginId);
    const r = await withTenant(A.id, async (db) => ({
      users: (await db.query('SELECT company_id FROM app.app_user')).rows,
      sessions: (await db.query('SELECT 1 FROM app.user_session')).rows,
      companies: (await db.query('SELECT id FROM app.company')).rows,
    }));
    expect(r.users.every((u) => u.company_id === A.id)).toBe(true);
    expect(r.users.length).toBeGreaterThan(0);
    expect(r.sessions).toEqual([]);
    expect(r.companies.map((c) => c.id)).toEqual([A.id]);
  });

  it('기업 문맥에서는 기업을 만들거나 수정할 수 없다', async () => {
    const ins = await code(withTenant(A.id, (db) => db.query("INSERT INTO app.company (code, name) VALUES ('EVILCO', 'x')")));
    expect(ins).toBe('42501');
    const upd = await withTenant(A.id, async (db) => (await db.query('UPDATE app.company SET is_active = false')).rowCount);
    expect(upd).toBe(0);
  });

  it('역할: 자기 기업 역할과 시스템 템플릿만 보이고, 템플릿은 고칠 수 없다', async () => {
    const r = await withTenant(A.id, async (db) => ({
      roles: (await db.query('SELECT company_id FROM app.role')).rows,
      updTemplate: (await db.query("UPDATE app.role SET name = 'x' WHERE company_id IS NULL")).rowCount,
      delTemplateAcl: (await db.query('DELETE FROM app.role_acl a USING app.role r WHERE r.id = a.role_id AND r.company_id IS NULL')).rowCount,
    }));
    expect(r.roles.every((x) => x.company_id === A.id || x.company_id === null)).toBe(true);
    expect(r.roles.filter((x) => x.company_id === A.id).length).toBe(3);
    expect(r.updTemplate).toBe(0);
    expect(r.delTemplateAcl).toBe(0);
  });

  it('다른 기업 역할에 허용 목록을 넣을 수 없다', async () => {
    const o = await owner();
    const bRole = (await o.query('SELECT id FROM app.role WHERE company_id = $1 LIMIT 1', [B.id])).rows[0].id;
    const r = await code(withTenant(A.id, (db) => db.query("INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, 'admin.user', 'create')", [bRole])));
    expect(['42501', '23505']).toContain(r);
    expect(r).toBe('42501');
  });

  it('다른 기업 계정에 자기 기업 역할을 배정할 수 없다', async () => {
    const o = await owner();
    const aRole = (await o.query('SELECT id FROM app.role WHERE company_id = $1 LIMIT 1', [A.id])).rows[0].id;
    const r = await code(withTenant(A.id, (db) => db.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [B.adminUserId, aRole, A.id])));
    expect(r).toBe('23503');
  });

  it('감사 로그: 자기 기업 것만 보이고, 수정·삭제는 권한 자체가 없다', async () => {
    const seen = await withTenant(A.id, async (db) => (await db.query('SELECT company_id FROM app.audit_log')).rows);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.company_id === A.id)).toBe(true);
    expect(await code(withTenant(A.id, (db) => db.query("UPDATE app.audit_log SET action = 'x'")))).toBe('42501');
    expect(await code(withTenant(A.id, (db) => db.query('DELETE FROM app.audit_log')))).toBe('42501');
    expect(await code(withSystem((db) => db.query('DELETE FROM app.audit_log')))).toBe('42501');
  });

  it('관리 부서를 비우면 기본 부서(IT)가 들어간다', async () => {
    const o = await owner();
    const cat = await o.query("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [A.id]);
    const model = await o.query(
      "INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Dell', 'L1') RETURNING id",
      [A.id, cat.rows[0].id],
    );
    const dept = await withTenant(A.id, async (db) => {
      const a = await db.query(
        "INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate) VALUES ($1, $2, 'A-0001', 'IN_STOCK', 'AVAILABLE') RETURNING department_id",
        [A.id, model.rows[0].id],
      );
      return (await db.query('SELECT name, is_default FROM app.department WHERE id = $1', [a.rows[0]!.department_id])).rows[0];
    });
    expect(dept).toEqual({ name: 'IT', is_default: true });
  });

  it('주변기기 재고는 ASSET 모델을 참조할 수 없다', async () => {
    const o = await owner();
    const model = (await o.query("SELECT id FROM app.item_model WHERE company_id = $1 AND kind = 'ASSET' LIMIT 1", [A.id])).rows[0].id;
    const r = await code(withTenant(A.id, (db) => db.query('INSERT INTO app.peripheral_stock (company_id, model_id) VALUES ($1, $2)', [A.id, model])));
    expect(r).toBe('23503');
  });

  it('허용되지 않은 상태 조합과 음수 수량은 DB가 거부한다', async () => {
    const o = await owner();
    const model = (await o.query("SELECT id FROM app.item_model WHERE company_id = $1 AND kind = 'ASSET' LIMIT 1", [A.id])).rows[0].id;
    const bad = (state: string, sub: string | null) =>
      code(withTenant(A.id, (db) => db.query('INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate) VALUES ($1, $2, $3, $4, $5)', [A.id, model, `X-${state}-${sub}`, state, sub])));
    expect(await bad('IN_STOCK', 'DISPOSED')).toBe('23514');
    expect(await bad('IN_USE', null)).toBe('23514'); // 보유자 없는 사용 중
    expect(await bad('RETIRED', null)).toBe('23514');
  });
});
