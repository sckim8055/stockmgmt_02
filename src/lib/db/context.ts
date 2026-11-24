// DB 접근의 유일한 입구.
//
// 규칙: 업무 코드는 반드시 withTenant() 로만 DB에 접근한다.
//       withSystem() 은 인증 모듈과 시스템 관리자 전용 기능에서만 쓴다(tests/guard.test.ts 가 사용처를 검사한다).
//       getPool() 을 직접 써서 쿼리하지 않는다.
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getPool } from './pool';

export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

async function run<T>(companyId: string, system: boolean, fn: (db: Db) => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    // 세 번째 인자 true = 이 트랜잭션에서만 유효. 커밋·롤백 후에는 사라진다.
    await client.query("SELECT set_config('app.company_id', $1, true), set_config('app.system', $2, true)", [
      companyId,
      system ? 'on' : 'off',
    ]);
    const db: Db = { query: (text, params) => client.query(text, params as unknown[]) };
    const result = await fn(db);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 연결이 끊긴 경우 */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 한 기업의 데이터만 보이는 트랜잭션. RLS가 다른 기업의 행을 막는다. */
export function withTenant<T>(companyId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!isUuid(companyId)) throw new Error('withTenant: 기업 ID가 올바르지 않습니다.');
  return run(companyId, false, fn);
}

/** 모든 기업의 데이터가 보이는 트랜잭션. 인증 처리와 시스템 관리자 기능에서만 쓴다. */
export function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return run('', true, fn);
}
