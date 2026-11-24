import { env } from '@/lib/env';
import { SESSION_ABSOLUTE_HOURS, SESSION_COOKIE } from '@/lib/auth/session';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return undefined; // 깨진 값은 쿠키가 없는 것으로 취급한다
    }
  }
  return undefined;
}

/**
 * 운영(HTTPS)에서는 __Host- 접두사를 붙인다. 이 접두사가 붙은 쿠키는 Secure·Path=/·Domain 없음일 때만
 * 브라우저가 받아들이므로, 같은 도메인의 다른 하위 사이트가 세션 쿠키를 심을 수 없다.
 */
export function sessionCookieName(): string {
  return env.cookieSecure ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

function base(): string {
  // HttpOnly: 스크립트에서 읽을 수 없다. SameSite=Lax: 다른 사이트의 POST 에 실려 가지 않는다.
  return `Path=/; HttpOnly; SameSite=Lax${env.cookieSecure ? '; Secure' : ''}`;
}

export function sessionCookie(token: string): string {
  return `${sessionCookieName()}=${encodeURIComponent(token)}; Max-Age=${SESSION_ABSOLUTE_HOURS * 3600}; ${base()}`;
}

export function clearSessionCookie(): string {
  return `${sessionCookieName()}=; Max-Age=0; ${base()}`;
}
