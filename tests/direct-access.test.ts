// 브라우저용 키로 DB에 직접 접근하는 경로가 막혀 있는지 확인한다.
// (기존 앱의 핵심 취약점이었던 경로)
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { APP_ROLE, closeOwner, makeCompany, owner } from './helpers';
import { closePool } from '@/lib/db/pool';

afterAll(async () => {
  await closeOwner();
  await closePool();
});

/** 지정한 역할로 SQL을 실행하고 결과 코드를 돌려준다. grantUsage 를 주면 스키마 접근 권한을 임시로 준 상태에서 시험한다. */
async function asRole(role: string, sql: string, grantUsage = false): Promise<string> {
  const c = new pg.Client({ connectionString: process.env.TEST_OWNER_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (grantUsage) await c.query(`GRANT USAGE ON SCHEMA app TO ${role}`);
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query(sql);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'error';
  } finally {
    await c.query('ROLLBACK').catch(() => undefined); // 임시 권한도 함께 되돌린다
    await c.end();
  }
}

describe('직접 접근 차단', () => {
  it('Supabase 역할(anon, authenticated, service_role)은 app 스키마의 어떤 테이블도 읽을 수 없다', async () => {
    await makeCompany();
    const o = await owner();
    const tables = await o.query("SELECT tablename FROM pg_tables WHERE schemaname = 'app'");
    expect(tables.rows.length).toBe(27);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const { tablename } of tables.rows) {
        // 42501 = insufficient_privilege
        expect(await asRole(role, `SELECT 1 FROM app.${tablename} LIMIT 1`), `${role} → ${tablename}`).toBe('42501');
      }
    }
  });

  it('누군가 스키마 접근 권한을 실수로 열어도, 테이블 권한이 없어서 읽을 수 없다', async () => {
    const o = await owner();
    const tables = await o.query("SELECT tablename FROM pg_tables WHERE schemaname = 'app'");
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const { tablename } of tables.rows) {
        expect(await asRole(role, `SELECT 1 FROM app.${tablename} LIMIT 1`, true), `${role} → ${tablename}`).toBe('42501');
      }
      expect(await asRole(role, "SELECT app.auth_password_hash('00000000-0000-0000-0000-000000000000')", true)).toBe('42501');
    }
  });

  it('PUBLIC 에는 app 스키마 사용 권한이 없다', async () => {
    const o = await owner();
    const r = await o.query("SELECT has_schema_privilege('anon', 'app', 'USAGE') AS anon, has_schema_privilege('authenticated', 'app', 'USAGE') AS auth, has_schema_privilege('service_role', 'app', 'USAGE') AS service");
    expect(r.rows[0]).toEqual({ anon: false, auth: false, service: false });
  });

  it('app 스키마의 객체는 public 스키마에 하나도 없다', async () => {
    const o = await owner();
    const r = await o.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    expect(r.rows[0].n).toBe(0);
  });

  it('앱 역할은 마이그레이션 기록 테이블에 접근할 수 없다', async () => {
    expect(await asRole(APP_ROLE, 'SELECT 1 FROM app.schema_migration')).toBe('42501');
  });
});
