// 모든 API 라우트는 이 route() 로 만든다. (tests/guard.test.ts 가 강제한다)
//
// route() 가 하는 일
//  1) 상태를 바꾸는 요청의 출처 검사(CSRF)
//  2) 세션 확인 → 사용자·기업 활성 여부 확인
//  3) 비밀번호 변경이 강제된 계정 차단
//  4) 선언된 접근 조건 검사: 사용자 유형(allow) 또는 권한(permission)
//  5) 예외를 일관된 JSON 오류로 변환
import type { z } from 'zod';
import { isUuid, withTenant, type Db } from '@/lib/db/context';
import { BusyError } from '@/lib/auth/password';
import { hasPermission, type Permission } from '@/lib/auth/permission';
import { resolveSession, type SessionUser, type UserType } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { readCookie, sessionCookieName } from './cookies';
import { HttpError, badRequest, forbidden, json, notFound, unauthorized } from './errors';

type Access =
  /** 로그인 없이 호출 가능. 로그인 API 같은 극소수에만 쓴다. */
  | { access: 'public' }
  /** 로그인한 본인에 관한 것(내 정보, 로그아웃, 비밀번호 변경). 비밀번호 변경이 강제된 상태에서도 허용. */
  | { access: 'self' }
  /** 지정한 사용자 유형만. */
  | { access: 'type'; allow: readonly UserType[] }
  /** 권한 판정을 거친다. 업무 API의 기본. */
  | { access: 'permission'; permission: Permission };

/** 요청을 보낸 사람. 기업 범위 안에서의 판정에 쓴다. */
export interface Actor {
  userId: string;
  userType: UserType;
  /** 작업 대상 기업. 기업 계정은 소속 기업, 시스템 관리자는 세션에서 고른 기업. */
  companyId: string;
  /** 기업 안에서 모든 권한을 갖는가(시스템 관리자, 기업 관리자). */
  isAdmin: boolean;
  /**
   * 기업의 감사 로그에 남길 IP. 시스템 관리자의 IP는 기업 로그에 남기지 않는다(null).
   * 운영자의 접속 정보가 고객사에 노출되지 않게 하기 위해서다.
   */
  auditIp: string | null;
}

export interface RouteContext<B> {
  req: Request;
  body: B;
  /** access 가 'public' 이 아니면 항상 있다. */
  user: SessionUser;
  ip: string | null;
  /** URL 경로의 [id]. UUID 형식이 아니면 404. */
  id(): string;
  /** 기업 범위의 요청자. 기업이 정해지지 않았으면(기업을 고르지 않은 시스템 관리자) 403. */
  actor(): Actor;
  /** 요청자의 기업 범위로 DB에 접근한다. */
  tenant<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

type Options<S extends z.ZodType | undefined> = Access & { body?: S };
type BodyOf<S> = S extends z.ZodType ? z.infer<S> : undefined;
type RouteExtra = { params?: Promise<Record<string, string | string[] | undefined>> };

const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

/**
 * 접속자 IP. 신뢰하도록 설정한 프록시 헤더(TRUSTED_IP_HEADER)에서만 읽는다.
 * x-forwarded-for 처럼 클라이언트가 마음대로 넣을 수 있는 헤더를 그대로 믿으면
 * IP 기준 제한을 피하거나, 남의 IP를 사칭해 그 사람의 로그인을 막을 수 있다.
 * 값이 목록이면 가장 가까운 프록시가 붙인 마지막 값을 쓴다.
 */
export function clientIp(req: Request): string | null {
  const header = env.trustedIpHeader;
  if (!header) return null;
  const value = req.headers.get(header)?.split(',').at(-1)?.trim();
  return value && IP_RE.test(value) ? value : null;
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

/** 권한 판정과 DB 접근에 쓰는 기업: 소속 기업, 없으면(시스템 관리자) 세션에서 고른 기업. */
function effectiveCompanyId(user: SessionUser): string | null {
  return user.companyId ?? user.actingCompanyId;
}

export function route<S extends z.ZodType | undefined = undefined>(
  options: Options<S>,
  handler: (ctx: RouteContext<BodyOf<S>>) => Promise<Response>,
): (req: Request, extra?: RouteExtra) => Promise<Response> {
  return async (req: Request, extra?: RouteExtra): Promise<Response> => {
    try {
      assertSameOrigin(req);

      let user: SessionUser | null = null;
      if (options.access !== 'public') {
        user = await resolveSession(readCookie(req, sessionCookieName()));
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
      const params = extra?.params ? await extra.params : {};
      const actor = (): Actor => {
        // 기업 ID는 요청 본문이 아니라 세션에서만 가져온다.
        const companyId = current ? effectiveCompanyId(current) : null;
        if (!current || !companyId) throw forbidden('기업이 선택되지 않았습니다.');
        // 화면이 보고 있는 기업과 세션의 기업이 다르면 거부한다.
        // (시스템 관리자가 다른 탭에서 기업을 바꾼 뒤, 이 탭의 요청이 엉뚱한 기업에 적용되는 것을 막는다)
        // 이 헤더는 "확인용"일 뿐이다. 기업은 여전히 세션에서만 정해진다.
        const expected = req.headers.get('x-expected-company');
        if (expected && expected !== companyId) {
          throw new HttpError(409, 'COMPANY_CHANGED', '작업 중인 기업이 바뀌었습니다. 화면을 새로 고친 뒤 다시 시도하세요.');
        }
        return {
          userId: current.userId,
          userType: current.userType,
          companyId,
          isAdmin: current.userType === 'SYSTEM_ADMIN' || current.userType === 'COMPANY_ADMIN',
          auditIp: current.userType === 'SYSTEM_ADMIN' ? null : clientIp(req),
        };
      };
      return await handler({
        req,
        body: body as BodyOf<S>,
        user: current as SessionUser,
        ip: clientIp(req),
        id: () => {
          const id = params.id;
          if (!isUuid(id)) throw notFound();
          return id;
        },
        actor,
        tenant: (fn) => withTenant(actor().companyId, fn),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { code: err.code, message: err.message } }, { status: err.status });
      }
      if (err instanceof BusyError) {
        return json({ error: { code: 'BUSY', message: '요청이 많습니다. 잠시 후 다시 시도하세요.' } }, { status: 503 });
      }
      console.error('[api] unhandled error', err);
      // 내부 오류 내용은 응답에 싣지 않는다.
      return json({ error: { code: 'INTERNAL', message: '서버 오류가 발생했습니다.' } }, { status: 500 });
    }
  };
}
