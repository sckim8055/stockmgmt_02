// 앱 역할의 실행 제한을 정한다. 배포 환경마다 실행한다(여러 번 실행해도 된다).
// 사용: MIGRATION_DATABASE_URL=... node scripts/set-role-limits.mjs
//
// 왜: 앱의 DB 연결은 모든 기업이 함께 쓴다. 느린 쿼리나 끝나지 않는 트랜잭션 하나가 연결을 오래 붙잡으면
// 다른 기업의 요청까지 실패한다. 앱 코드의 방어와 별개로, DB 가 마지막에 끊어 주게 한다.
//   statement_timeout                     쿼리 하나의 최대 실행 시간
//   lock_timeout                          잠금을 기다리는 최대 시간(엑셀 업로드 한 건이 끝나기를 기다리는 정도는 허용)
//   idle_in_transaction_session_timeout   트랜잭션을 연 채 아무것도 하지 않는 연결을 끊는 시간
// 값은 환경변수로 바꿀 수 있다. 0 은 제한 없음.
import pg from 'pg';

const url = process.env.MIGRATION_DATABASE_URL;
const appRole = process.env.APP_DB_ROLE ?? 'stock_app';
if (!url) {
  console.error('MIGRATION_DATABASE_URL 이 설정되지 않았습니다.');
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]{0,40}$/.test(appRole)) {
  console.error('APP_DB_ROLE 형식이 올바르지 않습니다.');
  process.exit(1);
}
const limits = {
  statement_timeout: process.env.APP_STATEMENT_TIMEOUT ?? '30s',
  lock_timeout: process.env.APP_LOCK_TIMEOUT ?? '30s',
  idle_in_transaction_session_timeout: process.env.APP_IDLE_TX_TIMEOUT ?? '60s',
};
for (const [name, value] of Object.entries(limits)) {
  if (!/^(0|[1-9]\d{0,6}(ms|s|min))$/.test(value)) {
    console.error(`${name} 값의 형식이 올바르지 않습니다: ${value} (예: 30s, 500ms, 2min, 0)`);
    process.exit(1);
  }
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const [name, value] of Object.entries(limits)) {
    const { rows } = await client.query("SELECT format('ALTER ROLE %I SET %I = %L', $1::text, $2::text, $3::text) AS sql", [appRole, name, value]);
    await client.query(rows[0].sql);
  }
  console.log(`${appRole} 실행 제한: ${Object.entries(limits).map(([k, v]) => `${k}=${v}`).join(', ')} (새 연결부터 적용)`);
} finally {
  await client.end();
}
