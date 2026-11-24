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
