import { z } from 'zod';
import { isoDate, line, str } from '@/lib/validation';
import { ASSET_SORT_KEYS, createAsset, listAssets } from '@/lib/assets/assets';
import { loadDataAccess } from '@/lib/authz/scope';
import { badRequest, json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const date = isoDate();

const Query = z.object({
  state: z.enum(['ON_ORDER', 'IN_STOCK', 'IN_USE', 'MAINTENANCE', 'MISSING', 'RETIRED', 'VOID']).optional(),
  substate: z.enum(['AVAILABLE', 'RESERVED', 'DEFECTIVE', 'PENDING_DISPOSAL', 'DISPOSED', 'SOLD', 'DONATED']).optional(),
  modelId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  holderPersonId: z.uuid().optional(),
  q: str().max(100).optional(),
  includeVoid: z.enum(['true', 'false']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  sort: z.enum(ASSET_SORT_KEYS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

const Body = z.object({
  modelId: z.uuid(),
  assetTag: line().trim().min(1).max(64),
  serialNumber: line().trim().max(100).nullish(),
  initialState: z.enum(['IN_STOCK', 'ON_ORDER']).optional(),
  departmentId: z.uuid().nullish(),
  location: str().trim().max(200).nullish(),
  purchaseDate: date.nullish(),
  purchasePrice: z.number().min(0).max(999999999999).nullish(),
  supplier: str().trim().max(200).nullish(),
  warrantyEnd: date.nullish(),
  custom: z.record(str(), z.unknown()).optional(),
});

export const GET = route(
  { access: 'permission', permission: { resource: 'asset.item', operation: 'read' } },
  async ({ req, actor, tenant }) => {
    const who = actor();
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    const { includeVoid, overdue, ...rest } = parsed.data;
    const result = await tenant(async (db) =>
      listAssets(db, who, await loadDataAccess(db, who), { ...rest, includeVoid: includeVoid === 'true', overdue: overdue === 'true' }),
    );
    return json(result);
  },
);

export const POST = route(
  { access: 'permission', permission: { resource: 'asset.item', operation: 'create' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const assetId = await tenant(async (db) => createAsset(db, who, await loadDataAccess(db, who), body));
    return json({ assetId }, { status: 201 });
  },
);
