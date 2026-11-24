// 환경변수는 이 파일에서만 읽는다. (DB 풀 크기만 pool.ts 에서 읽는다)
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 이(가) 설정되지 않았습니다.`);
  return v;
}

export const env = {
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  /** 시스템 관리자가 기업코드 칸에 입력하는 운영사 코드 */
  get operatorCode(): string {
    return (process.env.OPERATOR_CODE ?? 'OPERATOR').toUpperCase();
  },
  get cookieSecure(): boolean {
    return (process.env.COOKIE_SECURE ?? 'true') !== 'false';
  },
  /**
   * 접속자 IP를 담아 주는, 신뢰할 수 있는 프록시의 헤더 이름.
   * 예: Cloudflare Tunnel 은 cf-connecting-ip, Vercel 은 x-vercel-forwarded-for.
   * 설정하지 않으면 IP를 모르는 것으로 취급한다(클라이언트가 보낸 헤더를 믿지 않는다).
   */
  get trustedIpHeader(): string | null {
    return process.env.TRUSTED_IP_HEADER?.toLowerCase() || null;
  },
  /** 동시에 수행할 비밀번호 해시 계산 수. DB 풀 크기보다 작게 둔다. */
  get hashConcurrency(): number {
    return Math.max(1, Number(process.env.HASH_CONCURRENCY ?? 4));
  },
};
