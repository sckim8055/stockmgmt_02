// 첫 시스템 관리자 계정을 만든다. 서버에 접근할 수 있는 운영자만 실행한다.
// 사용: DATABASE_URL=... npm run admin:create-system -- <loginId> "<표시 이름>" [email]
// 시스템 관리자 전원이 로그인할 수 없게 됐을 때의 복구 수단이기도 하다.
import { withSystem } from '../src/lib/db/context';
import { closePool } from '../src/lib/db/pool';
import { writeAudit } from '../src/lib/auth/audit';
import { generateTempPassword, hashPassword, TEMP_PASSWORD_TTL_HOURS } from '../src/lib/auth/password';

const [loginId, displayName, email] = process.argv.slice(2);
if (!loginId || !displayName) {
  console.error('사용: npm run admin:create-system -- <loginId> "<표시 이름>" [email]');
  process.exit(1);
}

async function main(): Promise<void> {
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  try {
    const id = await withSystem(async (db) => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO app.app_user (company_id, login_id, password_hash, email, display_name, user_type,
                                   must_change_password, temp_password_expires_at)
         VALUES (NULL, $1, $2, $3, $4, 'SYSTEM_ADMIN', true, now() + make_interval(hours => $5))
         RETURNING id`,
        [loginId, passwordHash, email ?? null, displayName, TEMP_PASSWORD_TTL_HOURS],
      );
      const userId = r.rows[0]!.id;
      await writeAudit(db, { companyId: null, actorId: null, action: 'SYSTEM_ADMIN_CREATED', resource: 'system', targetId: userId });
      return userId;
    });
    console.log(`시스템 관리자를 만들었습니다: ${loginId} (${id})`);
    console.log(`임시 비밀번호(한 번만 표시): ${tempPassword}`);
    console.log(`${TEMP_PASSWORD_TTL_HOURS}시간 안에 로그인해서 비밀번호를 바꿔야 합니다.`);
  } catch (err) {
    console.error('실패:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

void main();
