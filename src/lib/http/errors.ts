export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new HttpError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
export const forbidden = (message = '권한이 없습니다.') => new HttpError(403, 'FORBIDDEN', message);
// 다른 기업·범위 밖의 데이터는 존재 여부를 알리지 않기 위해 404로 응답한다.
export const notFound = () => new HttpError(404, 'NOT_FOUND', '대상을 찾을 수 없습니다.');
export const badRequest = (message: string) => new HttpError(400, 'BAD_REQUEST', message);

export function json(data: unknown, init: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}
