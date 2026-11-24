import { z } from 'zod';
import { isoDate, str } from '@/lib/validation';
import { actOnAsset } from '@/lib/assets/assets';
import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

// 이 라우트가 받는 처리. 권한 리소스(asset.retire)에 속한 것만 나열한다(src/lib/assets/transitions.ts 의 ACTION_RESOURCE 와 일치).
const Body = z.strictObject({
  action: z.enum(['MARK_MISSING', 'FOUND', 'RETIRE', 'DISPOSE', 'VOID']),
  holderPersonId: z.uuid().nullish(),
  dueDate: isoDate().nullish(),
  defective: z.boolean().optional(),
  disposal: z.enum(['DISPOSED', 'SOLD', 'DONATED']).optional(),
  location: str().trim().max(200).nullable().optional(),
  note: str().trim().max(500).nullish(),
});

export const POST = route(
  { access: 'permission', permission: { resource: 'asset.retire', operation: 'execute' }, body: Body },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const assetId = id();
    const { action, ...input } = body;
    const result = await tenant(async (db) => actOnAsset(db, who, await loadDataAccess(db, who), assetId, action, input));
    return json(result);
  },
);
