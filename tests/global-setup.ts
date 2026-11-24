// 테스트용 DB를 매번 새로 만들고 마이그레이션만으로 구성한다.
// (= "빈 DB에서 마이그레이션만으로 구성된다"는 완료 기준을 매 실행마다 검증한다)
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:devpg@127.0.0.1:5432/postgres';
const OWNER_URL = process.env.TEST_OWNER_URL!;
const APP_PASSWORD = process.env.TEST_APP_PASSWORD!; // vitest.config.mts 가 실행마다 새로 만든다
const APP_ROLE = 'stock_app_test'; // 실제 앱 역할(stock_app)과 다른 이름

export default async function setup(): Promise<void> {
  if (!new URL(OWNER_URL).pathname.endsWith('/stock_test')) {
    throw new Error('테스트는 stock_test DB에서만 실행합니다. (이 DB는 매번 지우고 새로 만듭니다)');
  }
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS stock_test WITH (FORCE)');
  await admin.query('CREATE DATABASE stock_test');
  // Supabase 환경을 흉내 내기 위해 Supabase가 만들어 두는 역할을 미리 만든다.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!rowCount) await admin.query(`CREATE ROLE ${role} NOLOGIN`);
  }
  await admin.end();

  const env = { ...process.env, MIGRATION_DATABASE_URL: OWNER_URL, APP_DB_PASSWORD: APP_PASSWORD, APP_DB_ROLE: APP_ROLE };
  execFileSync('node', ['scripts/migrate.mjs'], { env, stdio: 'pipe' });
  execFileSync('node', ['scripts/set-app-password.mjs'], { env, stdio: 'pipe' });
}
