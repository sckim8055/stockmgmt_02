import { z } from 'zod';
import { str } from '@/lib/validation';
import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { adjustStock, MAX_QTY } from '@/lib/peripherals/peripherals';

// 조정과 폐기는 사유가 필수다.
const note = str().trim().min(1).max(500);
const Body = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('ADJUST'), stockId: z.uuid(), countedQty: z.number().int().min(0).max(MAX_QTY), note }),
  z.strictObject({ action: z.literal('DISPOSE'), stockId: z.uuid(), qty: z.number().int().min(1).max(MAX_QTY), note }),
]);

export const POST = route(
  { access: 'permission', permission: { resource: 'peripheral.adjust', operation: 'execute' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    return json(await tenant(async (db) => adjustStock(db, who, await loadDataAccess(db, who), body)));
  },
);
