import { afterAll, describe, expect, it } from 'vitest';
import { closeOwner, owner } from './helpers';

afterAll(closeOwner);

const GLOBAL_TABLES = ['schema_migration', 'sys_resource', 'sys_resource_operation'];

describe('스키마', () => {
  it('업무 테이블이 26개다', async () => {
    const o = await owner();
    const r = await o.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'app' AND tablename <> 'schema_migration'");
    expect(r.rows[0].n).toBe(26);
  });

  it('기업 데이터를 담는 모든 테이블에 RLS가 켜져 있고 정책이 있다', async () => {
    const o = await owner();
    const r = await o.query(
      `SELECT c.relname, c.relrowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind = 'r' AND c.relname <> ALL($1)`,
      [GLOBAL_TABLES],
    );
    expect(r.rows.length).toBe(24);
    for (const row of r.rows) {
      expect(row.relrowsecurity, `${row.relname} RLS`).toBe(true);
      expect(row.policies, `${row.relname} policies`).toBeGreaterThan(0);
    }
  });

  it('company_id 컬럼이 있는 테이블은 새로 추가돼도 RLS 없이 둘 수 없다', async () => {
    const o = await owner();
    const r = await o.query(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
        WHERE n.nspname = 'app' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual([]);
  });

  it('앱 역할은 소유자·슈퍼유저가 아니고 RLS를 우회할 수 없다', async () => {
    const o = await owner();
    const role = await o.query("SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'stock_app'");
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const owned = await o.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND pg_get_userbyid(c.relowner) = 'stock_app'`,
    );
    expect(owned.rows[0].n).toBe(0);
  });

  it('이력·감사 테이블은 앱 역할이 수정·삭제할 수 없다', async () => {
    const o = await owner();
    for (const t of ['asset_txn', 'peripheral_txn', 'audit_log', 'mail_log']) {
      for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE']) {
        const r = await o.query('SELECT has_table_privilege($1, $2, $3) AS ok', ['stock_app', `app.${t}`, priv]);
        expect(r.rows[0].ok, `${t} ${priv}`).toBe(false);
      }
    }
  });

  it('기업·계정·자산·직원은 앱 역할이 삭제할 수 없다', async () => {
    const o = await owner();
    for (const t of ['company', 'app_user', 'asset', 'person']) {
      const r = await o.query('SELECT has_table_privilege($1, $2, $3) AS ok', ['stock_app', `app.${t}`, 'DELETE']);
      expect(r.rows[0].ok, t).toBe(false);
    }
  });

  it('권한 시드: 리소스마다 동작이 정의돼 있고 역할 템플릿이 3개다', async () => {
    const o = await owner();
    const noOps = await o.query(
      `SELECT r.code FROM app.sys_resource r
        WHERE r.type <> 'MENU' AND NOT EXISTS (SELECT 1 FROM app.sys_resource_operation o WHERE o.resource_code = r.code)`,
    );
    expect(noOps.rows).toEqual([]);
    const t = await o.query('SELECT count(*)::int AS n FROM app.role WHERE company_id IS NULL');
    expect(t.rows[0].n).toBe(3);
  });
});
