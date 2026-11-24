import pg from 'pg';
import { env } from '@/lib/env';

// 개발 중 핫 리로드에서 풀이 여러 개 생기지 않게 전역에 하나만 둔다.
const g = globalThis as unknown as { __stockPool?: pg.Pool };

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

export async function closePool(): Promise<void> {
  if (g.__stockPool) {
    await g.__stockPool.end();
    g.__stockPool = undefined;
  }
}
