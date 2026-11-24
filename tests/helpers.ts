import pg from 'pg';
import { createCompany } from '@/lib/company/create';
import { hashPassword } from '@/lib/auth/password';
import { login } from '@/lib/auth/login';
import { sessionCookieName } from '@/lib/http/cookies';

/** 테이블 소유자 연결. 테스트 준비와 검증에만 쓴다(RLS를 거치지 않는다). */
let ownerClient: pg.Client | undefined;
export async function owner(): Promise<pg.Client> {
  if (!ownerClient) {
    ownerClient = new pg.Client({ connectionString: process.env.TEST_OWNER_URL });
    await ownerClient.connect();
  }
  return ownerClient;
}
export async function closeOwner(): Promise<void> {
  await ownerClient?.end();
  ownerClient = undefined;
}

/** 테스트에서 쓰는 앱 역할 이름 */
export const APP_ROLE = process.env.APP_DB_ROLE ?? 'stock_app';

let seq = 0;
export function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${seq}`;
}

export const GOOD_PASSWORD = 'Correct-Horse-42';

export interface TestCompany {
  id: string;
  code: string;
  adminLoginId: string;
  adminUserId: string;
}

/** 기업을 만들고, 첫 관리자의 비밀번호를 GOOD_PASSWORD 로 확정한다(임시 비밀번호 상태 해제). */
export async function makeCompany(prefix = 'CO'): Promise<TestCompany> {
  const code = uniq(prefix);
  const r = await createCompany({ code, name: `${code} Inc`, admin: { loginId: 'admin', displayName: 'Admin' } }, { userId: null });
  const o = await owner();
  await o.query(
    'UPDATE app.app_user SET password_hash = $2, must_change_password = false, temp_password_expires_at = NULL WHERE id = $1',
    [r.adminUserId, await hashPassword(GOOD_PASSWORD)],
  );
  return { id: r.companyId, code, adminLoginId: 'admin', adminUserId: r.adminUserId };
}

export async function makeUser(
  companyId: string | null,
  loginId: string,
  userType: 'SYSTEM_ADMIN' | 'COMPANY_ADMIN' | 'COMPANY_USER',
  opts: { mustChange?: boolean; password?: string } = {},
): Promise<string> {
  const o = await owner();
  const r = await o.query<{ id: string }>(
    `INSERT INTO app.app_user (company_id, login_id, password_hash, display_name, user_type, must_change_password)
     VALUES ($1, $2, $3, $2, $4, $5) RETURNING id`,
    [companyId, loginId, await hashPassword(opts.password ?? GOOD_PASSWORD), userType, opts.mustChange ?? false],
  );
  return r.rows[0]!.id;
}

/** 로그인해서 세션 쿠키 문자열을 돌려준다. */
export async function sessionFor(companyCode: string, loginId: string, password = GOOD_PASSWORD): Promise<string> {
  const r = await login({ companyCode, loginId, password });
  if (!r.ok) throw new Error(`테스트 로그인 실패: ${r.reason}`);
  return `${sessionCookieName()}=${r.token}`;
}

type Handler = (req: Request) => Promise<Response>;

export async function call(
  handler: Handler,
  opts: { method?: string; path?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: any; setCookie: string | null }> {
  const method = opts.method ?? 'GET';
  const headers = new Headers({ host: 'app.test', ...(opts.headers ?? {}) });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (method !== 'GET' && !headers.has('origin')) headers.set('origin', 'http://app.test');
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  const res = await handler(
    new Request(`http://app.test${opts.path ?? '/'}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* 본문 없음 */
  }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}
