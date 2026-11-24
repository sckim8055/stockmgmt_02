import { listResources } from '@/lib/admin/roles';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 권한 편집 화면이 쓰는 리소스 트리(메뉴 > 페이지 > 필드)와 리소스별 동작 목록.
export const GET = route(
  { access: 'permission', permission: { resource: 'admin.role', operation: 'read' } },
  async ({ tenant }) => json({ resources: await tenant((db) => listResources(db)) }),
);
