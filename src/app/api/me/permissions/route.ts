import { userPermissions, userScope } from '@/lib/authz/grants';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 화면이 메뉴와 버튼을 그릴 때 쓰는 "내 권한". 화면 표시용일 뿐이고, 실제 판정은 각 API가 다시 한다.
export const GET = route({ access: 'self' }, async ({ user, tenant }) => {
  const companyId = user.companyId ?? user.actingCompanyId;
  const isAdmin = user.userType !== 'COMPANY_USER';
  if (!companyId || isAdmin) {
    // all: true = 기업 안의 모든 권한(system.* 제외). 기업을 고르지 않은 시스템 관리자는 companyId 가 null 이다.
    return json({ all: isAdmin, companyId, permissions: [], departmentScope: null });
  }
  const result = await tenant(async (db) => ({
    permissions: [...(await userPermissions(db, user.userId))].sort(),
    departmentScope: await userScope(db, user.userId),
  }));
  return json({ all: false, companyId, ...result });
});
