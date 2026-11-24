import { z } from 'zod';
import { str } from '@/lib/validation';
import { changePassword } from '@/lib/auth/login';
import { sessionCookie } from '@/lib/http/cookies';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Body = z.object({
  currentPassword: str().min(1).max(128),
  newPassword: str().min(1).max(128),
});

export const POST = route({ access: 'self', body: Body }, async ({ req, body, user, ip }) => {
  const result = await changePassword({
    userId: user.userId,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
    ip,
    userAgent: req.headers.get('user-agent'),
  });
  if (!result.ok) {
    const status = result.reason === 'LOCKED' ? 429 : result.reason === 'BUSY' ? 503 : 400;
    return json({ error: { code: result.reason, message: result.message } }, { status });
  }
  return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(result.token) } });
});
