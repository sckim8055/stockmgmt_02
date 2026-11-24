import { z } from 'zod';
import { createCompany } from '@/lib/company/create';
import { withSystem } from '@/lib/db/context';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const SYSTEM_ONLY = { access: 'type', allow: ['SYSTEM_ADMIN'] } as const;

const Body = z.object({
  code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/, '영문·숫자·-·_ 2~32자'),
  name: z.string().trim().min(1).max(100),
  timezone: z.string().max(64).optional(),
  locale: z.enum(['ko', 'en', 'zh']).optional(),
  admin: z.object({
    loginId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$/, '영문·숫자·._@- 3~64자'),
    displayName: z.string().trim().min(1).max(100),
    email: z.email().max(200).nullish(),
  }),
});

export const GET = route(SYSTEM_ONLY, async () => {
  const rows = await withSystem(async (db) => {
    const r = await db.query(
      'SELECT id, code, name, timezone, locale, is_active, created_at FROM app.company ORDER BY code',
    );
    return r.rows;
  });
  return json({ companies: rows });
});

export const POST = route({ ...SYSTEM_ONLY, body: Body }, async ({ body, user, ip }) => {
  const result = await createCompany(body, { userId: user.userId, ip });
  // 임시 비밀번호는 이 응답에서 한 번만 내려간다.
  return json(result, { status: 201 });
});
