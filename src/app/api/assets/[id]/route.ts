import { z } from 'zod';
import { getAsset, updateAsset } from '@/lib/assets/assets';
import { loadDataAccess } from '@/lib/authz/scope';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식');

// 상태와 보유자는 여기서 바꿀 수 없다(처리 API 전용). 정의하지 않은 키는 거부한다.
const Body = z.strictObject({
  modelId: z.uuid().optional(),
  assetTag: z.string().trim().min(1).max(64).optional(),
  serialNumber: z.string().trim().max(100).nullable().optional(),
  departmentId: z.uuid().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  purchaseDate: date.nullable().optional(),
  purchasePrice: z.number().min(0).max(999999999999).nullable().optional(),
  supplier: z.string().trim().max(200).nullable().optional(),
  warrantyEnd: date.nullable().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

export const GET = route(
  { access: 'permission', permission: { resource: 'asset.item', operation: 'read' } },
  async ({ id, actor, tenant }) => {
    const who = actor();
    const assetId = id();
    return json({ asset: await tenant(async (db) => getAsset(db, who, await loadDataAccess(db, who), assetId)) });
  },
);

export const PATCH = route(
  { access: 'permission', permission: { resource: 'asset.item', operation: 'update' }, body: Body },
  async ({ body, id, actor, tenant }) => {
    const who = actor();
    const assetId = id();
    await tenant(async (db) => updateAsset(db, who, await loadDataAccess(db, who), assetId, body));
    return json({ ok: true });
  },
);
