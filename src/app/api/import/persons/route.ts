import { handleImport, templateResponse } from '@/lib/import/http';
import { route } from '@/lib/http/route';

// persons 엑셀 업로드. GET 은 빈 양식, POST 는 미리보기(?mode=preview) 또는 반영(?mode=commit). 본문은 .xlsx 파일 그대로.
export const GET = route(
  { access: 'permission', permission: { resource: 'master.person', operation: 'import' } },
  async () => templateResponse('persons'),
);

export const POST = route(
  { access: 'permission', permission: { resource: 'master.person', operation: 'import' } },
  async ({ req, actor, tenant }) => handleImport('persons', req, actor(), tenant),
);
