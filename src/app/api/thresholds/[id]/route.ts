import { z } from 'zod';
import { deleteThreshold, updateThreshold } from '@/lib/alerts/thresholds';
import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 대상(카테고리·모델)과 부서는 바꿀 수 없다.
const Body = z.strictObject({
  minQty: z.number().int().min(0).max(1_000_000).optional(),
  warnRatio: z.number().min(1).max(10).optional(),
  isActive: z.boolean().optional(),
});

export const PATCH = route(
  { access: 'permission', permission: { resource: 'threshold', operation: 'update' }, body: Body },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const thresholdId = id();
    await tenant(async (db) => updateThreshold(db, who, await loadDataAccess(db, who), thresholdId, body));
    return json({ ok: true });
  },
);

export const DELETE = route(
  { access: 'permission', permission: { resource: 'threshold', operation: 'delete' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const thresholdId = id();
    await tenant(async (db) => deleteThreshold(db, who, await loadDataAccess(db, who), thresholdId));
    return json({ ok: true });
  },
);
