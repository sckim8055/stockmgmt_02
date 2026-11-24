import { setPersonActive } from '@/lib/master/persons';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 퇴사 처리. 자산을 보유 중이거나 반납하지 않은 대여가 있으면 409 와 함께 그 수를 돌려준다.
export const POST = route(
  { access: 'permission', permission: { resource: 'master.person', operation: 'deactivate' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const personId = id();
    const result = await tenant((db) => setPersonActive(db, who, personId, false));
    if (!result.ok) {
      return json(
        {
          error: { code: 'HOLDS_ITEMS', message: '보유 중인 자산이나 반납하지 않은 대여가 있어 퇴사 처리할 수 없습니다. 먼저 회수하세요.' },
          holding: result.holding,
        },
        { status: 409 },
      );
    }
    return json({ ok: true });
  },
);
