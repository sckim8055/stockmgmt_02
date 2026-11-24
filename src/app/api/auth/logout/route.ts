import { revokeSession } from '@/lib/auth/session';
import { clearSessionCookie } from '@/lib/http/cookies';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

export const POST = route({ access: 'self' }, async ({ user }) => {
  await revokeSession(user.sessionId);
  return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
});
