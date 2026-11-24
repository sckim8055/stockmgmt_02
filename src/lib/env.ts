// 환경변수는 이 파일에서만 읽는다.
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
};
