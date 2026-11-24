import { applyTempPassword } from '@/lib/admin/users';
import { generateTempPassword, hashPassword } from '@/lib/auth/password';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const POST = route(
  { access: 'permission', permission: { resource: 'admin.user.password', operation: 'execute' } },
  async ({ id, actor, tenant, ip }) => {
    const who = actor();
    const targetId = id();
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    await tenant((db) => applyTempPassword(db, who, targetId, passwordHash, ip));
    // 임시 비밀번호는 이 응답에서 한 번만 내려간다.
    return json({ tempPassword });
  },
);
