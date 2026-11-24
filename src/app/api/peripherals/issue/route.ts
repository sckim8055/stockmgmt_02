import { z } from 'zod';
import { isoDate, str } from '@/lib/validation';
import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';
import { issueStock, MAX_QTY } from '@/lib/peripherals/peripherals';

const qty = z.number().int().min(1).max(MAX_QTY);
const note = str().trim().max(500).nullish();
const locationNote = str().trim().max(200).nullish();

// 지급(돌려받지 않음), 대여(돌려받음), 대여의 반납·분실 처리.
const Body = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('ISSUE'), stockId: z.uuid(), personId: z.uuid(), qty, locationNote, note }),
  z.strictObject({ action: z.literal('LOAN'), stockId: z.uuid(), personId: z.uuid(), qty, dueDate: isoDate().nullish(), locationNote, note }),
  z.strictObject({ action: z.literal('RETURN'), loanId: z.uuid(), qty, note }),
  z.strictObject({ action: z.literal('LOAN_LOSS'), loanId: z.uuid(), qty, note }),
]);

export const POST = route(
  { access: 'permission', permission: { resource: 'peripheral.issue', operation: 'execute' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    return json(await tenant(async (db) => issueStock(db, who, await loadDataAccess(db, who), body)));
  },
);
