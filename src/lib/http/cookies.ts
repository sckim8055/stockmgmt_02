import { env } from '@/lib/env';
import { SESSION_ABSOLUTE_HOURS, SESSION_COOKIE } from '@/lib/auth/session';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function base(): string {
  // HttpOnly: 스크립트에서 읽을 수 없다. SameSite=Lax: 다른 사이트의 POST 에 실려 가지 않는다.
  return `Path=/; HttpOnly; SameSite=Lax${env.cookieSecure ? '; Secure' : ''}`;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_ABSOLUTE_HOURS * 3600}; ${base()}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${base()}`;
}
