// db/migrations/*.sql 을 파일명 순서로 한 번씩 적용한다.
// 접속 주소: MIGRATION_DATABASE_URL (테이블 소유자 계정). 앱용 DATABASE_URL 로는 실행하지 않는다.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL 이 설정되지 않았습니다.');
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // 동시에 두 번 실행되지 않게 잠근다.
  await client.query('SELECT pg_advisory_lock(727001)');
  await client.query('CREATE SCHEMA IF NOT EXISTS app');
  await client.query(`CREATE TABLE IF NOT EXISTS app.schema_migration (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const applied = new Set((await client.query('SELECT name FROM app.schema_migration')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO app.schema_migration (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied  ${file}`);
      count += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAILED   ${file}: ${err.message}`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) console.log(count === 0 ? 'up to date' : `done (${count} applied)`);
} finally {
  await client.end();
}
