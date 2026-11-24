import { z } from 'zod';
import { str } from '@/lib/validation';
import { createCustomField, listCustomFields } from '@/lib/master/custom-fields';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Body = z.strictObject({
  key: str().regex(/^[a-z][a-z0-9_]{0,39}$/, '영문 소문자로 시작하고 영문 소문자·숫자·밑줄만, 40자 이내'),
  label: str().trim().min(1).max(80),
  dataType: z.enum(['text', 'number', 'date', 'boolean']),
  isRestricted: z.boolean().optional(),
  sortOrder: z.number().int().min(-100000).max(100000).optional(),
  isActive: z.boolean().optional(),
});

export const GET = route(
  { access: 'permission', permission: { resource: 'master.custom_field', operation: 'read' } },
  async ({ actor, tenant }) => {
    const who = actor();
    return json({ fields: await tenant((db) => listCustomFields(db, who)) });
  },
);

export const POST = route(
  { access: 'permission', permission: { resource: 'master.custom_field', operation: 'create' }, body: Body },
  async ({ body, actor, tenant }) => {
    const who = actor();
    const fieldId = await tenant((db) => createCustomField(db, who, body));
    return json({ fieldId }, { status: 201 });
  },
);
