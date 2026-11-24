// DB 접근의 유일한 입구.
//
// 규칙: 업무 코드는 반드시 withTenant() 로만 DB에 접근한다.
//       withSystem() 은 인증 모듈과 시스템 관리자 전용 기능에서만 쓴다(tests/guard.test.ts 가 사용처를 검사한다).
//       getPool() 을 직접 써서 쿼리하지 않는다. set_config / SET 으로 문맥을 직접 바꾸지 않는다.
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ensureSafeRole, getPool } from './pool';

export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

async function run<T>(companyId: string, system: boolean, fn: (db: Db) => Promise<T>): Promise<T> {
  await ensureSafeRole();
  const client: PoolClient = await getPool().connect();
  // 트랜잭션이 끝난 뒤에는 이 핸들로 쿼리할 수 없다.
  // (연결은 풀로 돌아가 다른 요청·다른 기업의 문맥으로 재사용되므로, 끝난 핸들이 살아 있으면 격리가 깨진다)
  let closed = false;
  let broken = false;
  try {
    await client.query('BEGIN');
    // 세 번째 인자 true = 이 트랜잭션에서만 유효. 커밋·롤백 후에는 사라진다.
    await client.query("SELECT set_config('app.company_id', $1, true), set_config('app.system', $2, true)", [
      companyId,
      system ? 'on' : 'off',
    ]);
    const db: Db = {
      query: (text, params) => {
        if (closed) {
          return Promise.reject(
            new Error('트랜잭션이 끝난 뒤에 DB 핸들을 사용했습니다. await 가 빠진 비동기 코드가 있는지 확인하세요.'),
          );
        }
        return client.query(text, params as unknown[]);
      },
    };
    const result = await fn(db);
    closed = true;
    const commit = await client.query('COMMIT');
    // 쿼리 오류를 try/catch 로 삼킨 코드가 있으면 Postgres 는 COMMIT 에 ROLLBACK 으로 답한다.
    // 저장되지 않았는데 성공한 것처럼 보이는 일을 막는다.
    if (commit.command !== 'COMMIT') {
      throw new Error('트랜잭션이 중단되어 아무것도 저장되지 않았습니다. 쿼리 오류를 무시한 코드가 있습니다.');
    }
    return result;
  } catch (err) {
    closed = true;
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // 연결이 끊긴 경우: 풀에 되돌리지 않고 버린다.
    }
    throw err;
  } finally {
    closed = true;
    client.release(broken ? true : undefined);
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
