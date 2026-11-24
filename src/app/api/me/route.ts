import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const GET = route({ access: 'self' }, async ({ user }) =>
  json({
    user: {
      loginId: user.loginId,
      displayName: user.displayName,
      userType: user.userType,
      lang: user.lang,
      companyId: user.companyId,
      // 시스템 관리자가 이 세션에서 고른 기업(없으면 null)
      actingCompanyId: user.actingCompanyId,
      mustChangePassword: user.mustChangePassword,
    },
  }),
);
