// 앱 역할(stock_app)에 로그인 비밀번호를 설정한다. 배포 환경마다 한 번 실행한다.
// 사용: MIGRATION_DATABASE_URL=... APP_DB_PASSWORD=... node scripts/set-app-password.mjs
import pg from 'pg';

const url = process.env.MIGRATION_DATABASE_URL;
const password = process.env.APP_DB_PASSWORD;
if (!url || !password) {
  console.error('MIGRATION_DATABASE_URL 과 APP_DB_PASSWORD 가 모두 필요합니다.');
  process.exit(1);
}
if (password.length < 16) {
  console.error('APP_DB_PASSWORD 는 16자 이상이어야 합니다.');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query("SELECT format('ALTER ROLE stock_app LOGIN PASSWORD %L', $1::text) AS sql", [password]);
  await client.query(rows[0].sql);
  console.log('stock_app 비밀번호를 설정했습니다.');
} finally {
  await client.end();
}
