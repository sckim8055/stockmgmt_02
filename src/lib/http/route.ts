// 모든 API 라우트는 이 route() 로 만든다. (tests/guard.test.ts 가 강제한다)
//
// route() 가 하는 일
//  1) 상태를 바꾸는 요청의 출처 검사(CSRF)
//  2) 세션 확인 → 사용자·기업 활성 여부 확인
//  3) 비밀번호 변경이 강제된 계정 차단
//  4) 선언된 접근 조건 검사: 사용자 유형(allow) 또는 권한(permission)
//  5) 예외를 일관된 JSON 오류로 변환
import type { z } from 'zod';
import { withTenant, type Db } from '@/lib/db/context';
import { hasPermission, type Permission } from '@/lib/auth/permission';
import { resolveSession, SESSION_COOKIE, type SessionUser, type UserType } from '@/lib/auth/session';
import { readCookie } from './cookies';
import { HttpError, badRequest, forbidden, json, unauthorized } from './errors';

type Access =
  /** 로그인 없이 호출 가능. 로그인 API 같은 극소수에만 쓴다. */
  | { access: 'public' }
  /** 로그인한 본인에 관한 것(내 정보, 로그아웃, 비밀번호 변경). 비밀번호 변경이 강제된 상태에서도 허용. */
  | { access: 'self' }
  /** 지정한 사용자 유형만. */
  | { access: 'type'; allow: readonly UserType[] }
  /** 권한 판정을 거친다. 업무 API의 기본. */
  | { access: 'permission'; permission: Permission };

export interface RouteContext<B> {
  req: Request;
  body: B;
  /** access 가 'public' 이 아니면 항상 있다. */
  user: SessionUser;
  ip: string | null;
  /** 로그인한 사용자의 기업 범위로 DB에 접근한다. */
  tenant<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

type Options<S extends z.ZodType | undefined> = Access & { body?: S };
type BodyOf<S> = S extends z.ZodType ? z.infer<S> : undefined;

export function clientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  const first = fwd?.split(',')[0]?.trim();
  return first || req.headers.get('x-real-ip') || null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 다른 사이트에서 보낸 상태 변경 요청을 막는다. */
function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method)) return;
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw forbidden('허용되지 않은 출처입니다.');
  const origin = req.headers.get('origin');
  if (!origin) return; // 브라우저가 아닌 클라이언트. 쿠키가 자동으로 실리지 않으므로 CSRF 대상이 아니다.
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden('허용되지 않은 출처입니다.');
  }
  const allowed = new Set(
    [new URL(req.url).host, req.headers.get('host'), req.headers.get('x-forwarded-host')].filter(Boolean),
  );
  if (!allowed.has(originHost)) throw forbidden('허용되지 않은 출처입니다.');
}

export function route<S extends z.ZodType | undefined = undefined>(
  options: Options<S>,
  handler: (ctx: RouteContext<BodyOf<S>>) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      assertSameOrigin(req);

      let user: SessionUser | null = null;
      if (options.access !== 'public') {
        user = await resolveSession(readCookie(req, SESSION_COOKIE));
        if (!user) throw unauthorized();
        if (options.access !== 'self' && user.mustChangePassword) {
          throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', '비밀번호를 먼저 변경해야 합니다.');
        }
        if (options.access === 'type' && !options.allow.includes(user.userType)) throw forbidden();
        if (options.access === 'permission' && !(await hasPermission(user, options.permission))) throw forbidden();
      }

      let body: unknown = undefined;
      if (options.body) {
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          throw badRequest('요청 본문이 올바른 JSON이 아닙니다.');
        }
        const parsed = options.body.safeParse(raw);
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          throw badRequest(first ? `${first.path.join('.') || '본문'}: ${first.message}` : '입력값이 올바르지 않습니다.');
        }
        body = parsed.data;
      }

      const current = user;
      return await handler({
        req,
        body: body as BodyOf<S>,
        user: current as SessionUser,
        ip: clientIp(req),
        tenant: (fn) => {
          // 기업 ID는 요청 본문이 아니라 세션에서만 가져온다.
          if (!current?.companyId) throw forbidden('기업이 선택되지 않았습니다.');
          return withTenant(current.companyId, fn);
        },
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { code: err.code, message: err.message } }, { status: err.status });
      }
      console.error('[api] unhandled error', err);
      // 내부 오류 내용은 응답에 싣지 않는다.
      return json({ error: { code: 'INTERNAL', message: '서버 오류가 발생했습니다.' } }, { status: 500 });
    }
  };
}
