import { z } from 'zod';
import { line } from '@/lib/validation';
import { createUser, listUsers } from '@/lib/admin/users';
import { generateTempPassword, hashPassword } from '@/lib/auth/password';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Body = z.object({
  loginId: line().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$/, '영문·숫자·._@- 3~64자'),
  displayName: line().trim().min(1).max(100),
  email: z.email().max(200).nullish(),
  lang: z.enum(['ko', 'en', 'zh']).optional(),
  userType: z.enum(['COMPANY_ADMIN', 'COMPANY_USER']),
  roleIds: z.array(z.uuid()).max(50).default([]),
  departmentIds: z.array(z.uuid()).max(200).default([]),
});

export const GET = route(
  { access: 'permission', permission: { resource: 'admin.user', operation: 'read' } },
  async ({ tenant }) => json({ users: await tenant((db) => listUsers(db)) }),
);

export const POST = route(
  { access: 'permission', permission: { resource: 'admin.user', operation: 'create' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    // 해시 계산은 DB 연결을 잡기 전에 끝낸다.
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const userId = await tenant((db) => createUser(db, who, body, passwordHash, who.auditIp));
    // 임시 비밀번호는 이 응답에서 한 번만 내려간다.
    return json({ userId, tempPassword }, { status: 201 });
  },
);
