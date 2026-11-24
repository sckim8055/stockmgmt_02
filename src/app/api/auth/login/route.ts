import { z } from 'zod';
import { str } from '@/lib/validation';
import { login } from '@/lib/auth/login';
import { sessionCookie } from '@/lib/http/cookies';
import { json } from '@/lib/http/errors';
import { route } from '@/lib/http/route';

const Body = z.object({
  companyCode: str().min(1).max(32),
  loginId: str().min(1).max(64),
  password: str().min(1).max(128),
});

export const POST = route({ access: 'public', body: Body }, async ({ req, body, ip }) => {
  const result = await login({ ...body, ip, userAgent: req.headers.get('user-agent') });
  if (!result.ok) {
    if (result.reason === 'RATE_LIMITED') {
      return json({ error: { code: 'RATE_LIMITED', message: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.' } }, { status: 429 });
    }
    // 기업코드·ID·비밀번호 중 무엇이 틀렸는지, 계정이 잠겼는지 구분해서 알려주지 않는다.
    return json(
      { error: { code: 'LOGIN_FAILED', message: '로그인 정보가 올바르지 않거나 계정을 사용할 수 없습니다.' } },
      { status: 401 },
    );
  }
  return json({ user: result.user }, { headers: { 'set-cookie': sessionCookie(result.token) } });
});
