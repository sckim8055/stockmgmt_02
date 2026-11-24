// 모든 API 라우트가 선언한 접근 방식·권한을 한 표로 고정한다.
// 라우트의 권한을 바꾸거나 라우트를 추가하면 이 표도 함께 바꿔야 한다(권한이 조용히 약해지는 것을 막는다).
// 역할마다 여러 권한을 함께 갖고 있어, 동작 테스트만으로는 "다른 권한으로 바뀐 것"을 잡지 못한다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const API = join(process.cwd(), 'src/app/api');
// Next.js 는 route.ts 외의 확장자도 라우트로 제공한다.
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs)$/;
// 주석 안의 글자를 권한 선언으로 잘못 읽지 않게 지운다.
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : ROUTE_FILE.test(name) ? [p] : [];
  });
}

function declared(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of routeFiles(API)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const path = '/' + relative(API, file).replace(/\/?route\.\w+$/, '');
    const re = /export const (GET|POST|PATCH|PUT|DELETE) = route\(([\s\S]*?),\s*async\b/g;
    for (const m of src.matchAll(re)) {
      // 옵션을 상수로 빼 둔 파일(예: SYSTEM_ONLY)은 그 상수의 내용을 이어 붙여 읽는다.
      const opts = m[2]!.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, (name) => new RegExp(`const ${name} = (\\{[^;]*\\})`).exec(src)?.[1] ?? name);
      const access = /access:\s*'(\w+)'/.exec(opts)?.[1] ?? '?';
      const perm = /resource:\s*'([\w.]+)',\s*operation:\s*'(\w+)'/.exec(opts);
      const types = /allow:\s*\[([^\]]*)\]/.exec(opts)?.[1]?.replace(/['\s]/g, '');
      out[`${m[1]} ${path}`] = access === 'permission' ? `${perm?.[1]}:${perm?.[2]}` : types ? `${access}[${types}]` : access;
    }
    // route() 로 선언한 수와 export 수가 같아야 한다(정규식이 놓친 라우트가 없는지).
    const exports = [...src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\b/g)].length;
    const matched = [...src.matchAll(re)].length;
    expect(matched, file).toBe(exports);
  }
  return out;
}

describe('라우트별 권한 선언', () => {
  it('표와 정확히 일치한다', () => {
    expect(declared()).toMatchInlineSnapshot(`
      {
        "DELETE /admin/roles/[id]": "admin.role:delete",
        "DELETE /departments/[id]": "master.department:delete",
        "DELETE /mail/schedules/[id]": "mail.schedule:delete",
        "DELETE /master/categories/[id]": "master.category:delete",
        "DELETE /master/custom-fields/[id]": "master.custom_field:delete",
        "DELETE /master/models/[id]": "master.model:delete",
        "DELETE /thresholds/[id]": "threshold:delete",
        "GET /admin/resources": "admin.role:read",
        "GET /admin/roles": "admin.role:read",
        "GET /admin/users": "admin.user:read",
        "GET /alerts": "alert.inbox:read",
        "GET /assets": "asset.item:read",
        "GET /assets/[id]": "asset.item:read",
        "GET /assets/[id]/history": "history.stock:read",
        "GET /dashboard": "dashboard:read",
        "GET /departments": "master.department:read",
        "GET /history/audit": "history.audit:read",
        "GET /history/stock": "history.stock:read",
        "GET /import/assets": "asset.item:import",
        "GET /import/peripherals": "peripheral.receive:execute",
        "GET /import/persons": "master.person:import",
        "GET /mail/logs": "mail.log:read",
        "GET /mail/schedules": "mail.schedule:read",
        "GET /mail/schedules/[id]/preview": "mail.schedule:read",
        "GET /master/categories": "master.category:read",
        "GET /master/custom-fields": "master.custom_field:read",
        "GET /master/models": "master.model:read",
        "GET /master/persons": "master.person:read",
        "GET /me": "self",
        "GET /me/permissions": "self",
        "GET /peripherals": "peripheral.stock:read",
        "GET /peripherals/[id]/history": "history.stock:read",
        "GET /peripherals/loans": "peripheral.loan:read",
        "GET /system/companies": "type[SYSTEM_ADMIN]",
        "GET /thresholds": "threshold:read",
        "PATCH /admin/roles/[id]": "admin.role:update",
        "PATCH /admin/users/[id]": "admin.user:update",
        "PATCH /assets/[id]": "asset.item:update",
        "PATCH /departments/[id]": "master.department:update",
        "PATCH /mail/schedules/[id]": "mail.schedule:update",
        "PATCH /master/categories/[id]": "master.category:update",
        "PATCH /master/custom-fields/[id]": "master.custom_field:update",
        "PATCH /master/models/[id]": "master.model:update",
        "PATCH /master/persons/[id]": "master.person:update",
        "PATCH /me": "self",
        "PATCH /thresholds/[id]": "threshold:update",
        "POST /admin/roles": "admin.role:create",
        "POST /admin/users": "admin.user:create",
        "POST /admin/users/[id]/activate": "admin.user:activate",
        "POST /admin/users/[id]/deactivate": "admin.user:deactivate",
        "POST /admin/users/[id]/temp-password": "admin.user.password:execute",
        "POST /admin/users/[id]/unlock": "admin.user:update",
        "POST /alerts/read": "alert.inbox:read",
        "POST /assets": "asset.item:create",
        "POST /assets/[id]/assign": "asset.assign:execute",
        "POST /assets/[id]/maintain": "asset.maintain:execute",
        "POST /assets/[id]/retire": "asset.retire:execute",
        "POST /auth/change-password": "self",
        "POST /auth/login": "public",
        "POST /auth/logout": "self",
        "POST /departments": "master.department:create",
        "POST /departments/[id]/activate": "master.department:activate",
        "POST /departments/[id]/deactivate": "master.department:deactivate",
        "POST /import/assets": "asset.item:import",
        "POST /import/peripherals": "peripheral.receive:execute",
        "POST /import/persons": "master.person:import",
        "POST /mail/schedules": "mail.schedule:create",
        "POST /mail/schedules/[id]/activate": "mail.schedule:activate",
        "POST /mail/schedules/[id]/deactivate": "mail.schedule:deactivate",
        "POST /master/categories": "master.category:create",
        "POST /master/categories/[id]/activate": "master.category:activate",
        "POST /master/categories/[id]/deactivate": "master.category:deactivate",
        "POST /master/custom-fields": "master.custom_field:create",
        "POST /master/models": "master.model:create",
        "POST /master/models/[id]/activate": "master.model:activate",
        "POST /master/models/[id]/deactivate": "master.model:deactivate",
        "POST /master/persons": "master.person:create",
        "POST /master/persons/[id]/activate": "master.person:activate",
        "POST /master/persons/[id]/anonymize": "master.person:deactivate",
        "POST /master/persons/[id]/deactivate": "master.person:deactivate",
        "POST /peripherals/adjust": "peripheral.adjust:execute",
        "POST /peripherals/issue": "peripheral.issue:execute",
        "POST /peripherals/receive": "peripheral.receive:execute",
        "POST /system/acting-company": "type[SYSTEM_ADMIN]",
        "POST /system/companies": "type[SYSTEM_ADMIN]",
        "POST /thresholds": "threshold:create",
      }
    `);
  });
});
