import { z } from 'zod';
import { createThreshold, listThresholds } from '@/lib/alerts/thresholds';
import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Body = z.strictObject({
  categoryId: z.uuid().nullish(),
  modelId: z.uuid().nullish(),
  departmentId: z.uuid().nullish(),
  minQty: z.number().int().min(0).max(1_000_000),
  warnRatio: z.number().min(1).max(10).optional(),
});

export const GET = route(
  { access: 'permission', permission: { resource: 'threshold', operation: 'read' } },
  async ({ actor, tenant }) => {
    const who = actor();
    return json({ thresholds: await tenant(async (db) => listThresholds(db, who, await loadDataAccess(db, who))) });
  },
);

export const POST = route(
  { access: 'permission', permission: { resource: 'threshold', operation: 'create' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const thresholdId = await tenant(async (db) => createThreshold(db, who, await loadDataAccess(db, who), body));
    return json({ thresholdId }, { status: 201 });
  },
);
