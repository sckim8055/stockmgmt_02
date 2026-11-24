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
      mustChangePassword: user.mustChangePassword,
    },
  }),
);
