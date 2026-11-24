import { z } from 'zod';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const GET = route({ access: 'self' }, async ({ user, tenant }) => {
  // 작업 대상 기업: 소속 기업, 시스템 관리자는 세션에서 고른 기업. 화면 표시에 쓸 코드와 이름을 함께 내려준다.
  const effectiveCompanyId = user.companyId ?? user.actingCompanyId;
  const company = effectiveCompanyId
    ? await tenant(async (db) => {
        const r = await db.query<{ id: string; code: string; name: string }>('SELECT id, code, name FROM app.company WHERE id = $1', [
          effectiveCompanyId,
        ]);
        return r.rows[0] ?? null;
      })
    : null;
  return json({
    user: {
      userId: user.userId,
      loginId: user.loginId,
      displayName: user.displayName,
      userType: user.userType,
      lang: user.lang,
      companyId: user.companyId,
      // 시스템 관리자가 이 세션에서 고른 기업(없으면 null)
      actingCompanyId: user.actingCompanyId,
      company,
      mustChangePassword: user.mustChangePassword,
    },
  });
});

const Body = z.strictObject({ lang: z.enum(['ko', 'en', 'zh']) });

// 자기 화면 언어를 바꾼다. 바꿀 수 있는 것은 언어뿐이다(이름·권한 등은 계정 관리에서만).
// 기업에 속한 계정만 저장된다. 시스템 관리자는 기업 문맥 밖의 계정이라 여기서 저장하지 않고(saved: false) 브라우저에만 남는다.
export const PATCH = route({ access: 'self', body: Body }, async ({ body, user, tenant }) => {
  if (!user.companyId) return json({ saved: false });
  const companyId = user.companyId;
  const updated = await tenant(async (db) => {
    const r = await db.query('UPDATE app.app_user SET lang = $1 WHERE id = $2 AND company_id = $3', [body.lang, user.userId, companyId]);
    return r.rowCount ?? 0;
  });
  return json({ saved: updated === 1 });
});
