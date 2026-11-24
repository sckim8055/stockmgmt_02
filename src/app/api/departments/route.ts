import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 기준이 되는 업무 API 예시: 권한을 선언하고, tenant() 로만 DB에 접근한다.
export const GET = route(
  { access: 'permission', permission: { resource: 'master.department', operation: 'read' } },
  async ({ tenant }) => {
    const rows = await tenant(async (db) => {
      const r = await db.query('SELECT id, name, is_default, is_active FROM app.department ORDER BY is_default DESC, name');
      return r.rows;
    });
    return json({ departments: rows });
  },
);
