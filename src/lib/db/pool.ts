import pg from 'pg';
import { env } from '@/lib/env';

// 개발 중 핫 리로드에서 풀이 여러 개 생기지 않게 전역에 하나만 둔다.
const g = globalThis as unknown as { __stockPool?: pg.Pool; __stockRoleOk?: Promise<void> };

export function getPool(): pg.Pool {
  if (!g.__stockPool) {
    g.__stockPool = new pg.Pool({
      connectionString: env.databaseUrl,
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return g.__stockPool;
}

export class UnsafeDbRoleError extends Error {}

/**
 * 접속 역할이 RLS를 우회할 수 있는지 검사한다.
 * 슈퍼유저, BYPASSRLS, 테이블 소유자(또는 그 구성원)로 접속하면 RLS가 조용히 적용되지 않아
 * 모든 기업의 데이터가 보인다. 그런 접속 주소로는 서버가 동작을 거부한다.
 */
export async function assertSafeRole(q: { query: (text: string) => Promise<{ rows: any[] }> }): Promise<void> {
  const { rows } = await q.query(
    `SELECT r.rolname, r.rolsuper, r.rolbypassrls,
            -- 테이블 소유자이거나 소유자 역할의 구성원(상속 여부와 무관하게)
            EXISTS (SELECT 1 FROM pg_class c
                      JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
                       AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS owns,
            -- 슈퍼유저·BYPASSRLS 역할, 또는 모든 테이블을 읽고 쓰는 내장 역할의 구성원
            -- (컬럼 권한과 추가 전용 규칙을 우회한다)
            EXISTS (SELECT 1 FROM pg_roles x
                     WHERE x.rolname <> current_user
                       AND (x.rolsuper OR x.rolbypassrls OR x.rolname IN ('pg_read_all_data', 'pg_write_all_data'))
                       AND pg_has_role(current_user, x.oid, 'MEMBER')) AS inherits_bypass
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const r = rows[0];
  if (!r || r.rolsuper || r.rolbypassrls || r.owns || r.inherits_bypass) {
    throw new UnsafeDbRoleError(
      `DATABASE_URL 의 역할(${r?.rolname ?? '?'})은 RLS를 우회할 수 있어 사용할 수 없습니다. ` +
        '앱 전용 역할(stock_app)의 접속 주소를 넣으세요. 소유자 계정은 MIGRATION_DATABASE_URL 에만 씁니다.',
    );
  }
}

/** 프로세스당 한 번 역할을 검사한다. 안전하지 않으면 이후 모든 DB 접근이 실패한다. */
export function ensureSafeRole(): Promise<void> {
  if (!g.__stockRoleOk) {
    const p = assertSafeRole(getPool());
    g.__stockRoleOk = p;
    p.catch((err) => {
      // 일시적인 접속 오류는 다음 요청에서 다시 검사한다. 역할이 위험하다는 판정은 유지한다.
      if (!(err instanceof UnsafeDbRoleError) && g.__stockRoleOk === p) g.__stockRoleOk = undefined;
    });
  }
  return g.__stockRoleOk;
}

export async function closePool(): Promise<void> {
  if (g.__stockPool) {
    await g.__stockPool.end();
    g.__stockPool = undefined;
  }
  g.__stockRoleOk = undefined;
}
