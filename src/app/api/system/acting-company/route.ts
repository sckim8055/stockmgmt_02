import { z } from 'zod';
import { setActingCompany } from '@/lib/auth/session';
import { json, notFound } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Body = z.object({ companyId: z.uuid().nullable() });

// 시스템 관리자가 작업할 기업을 고른다(null 이면 해제). 접근 사실은 그 기업의 감사 로그에 남는다.
export const POST = route(
  { access: 'type', allow: ['SYSTEM_ADMIN'], body: Body },
  async ({ body, user, ip }) => {
    if (!(await setActingCompany(user, body.companyId, ip))) throw notFound();
    return json({ ok: true, companyId: body.companyId });
  },
);
