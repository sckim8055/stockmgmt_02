import { z } from 'zod';
import { str } from '@/lib/validation';
import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { MAX_QTY, receiveStock } from '@/lib/peripherals/peripherals';

const Body = z.strictObject({
  modelId: z.uuid(),
  departmentId: z.uuid().nullish(),
  qty: z.number().int().min(1).max(MAX_QTY),
  note: str().trim().max(500).nullish(),
});

export const POST = route(
  { access: 'permission', permission: { resource: 'peripheral.receive', operation: 'execute' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    return json(await tenant(async (db) => receiveStock(db, who, await loadDataAccess(db, who), body)));
  },
);
