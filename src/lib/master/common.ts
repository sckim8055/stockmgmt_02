// 기준 정보(카테고리·모델·부서·직원·사용자 지정 필드)가 함께 쓰는 도구. 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
import type { Db } from '@/lib/db/context';
import { HttpError } from '@/lib/http/errors';

/**
 * 한 기업 안의 기준 정보 변경(카테고리·모델·직원·사용자 지정 필드)을 한 줄로 세운다(트랜잭션이 끝날 때까지 유지).
 * "중복 검사 → 저장", "사용 여부 검사 → 삭제" 사이에 다른 요청이 끼어들어 500(고유 제약 위반)이 나거나
 * 검사를 빠져나가는 것을 막는다. 부서는 계정의 부서 범위와 얽혀 있어 계정·역할 관리와 같은 잠금
 * (lockCompanyAdministration)을 쓴다.
 * 기준 정보 변경은 빈도가 낮아 직렬화해도 부담이 없다.
 */
export async function lockMasterData(db: Db, companyId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(727003, hashtext($1))', [companyId]);
}

export const conflict = (code: string, message: string) => new HttpError(409, code, message);

/** LIKE 패턴 문자를 글자 그대로 검색하도록 이스케이프한다. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

function pgCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * DB 제약 위반을 사용자에게 의미 있는 HTTP 오류로 바꿔 다시 던진다. 오류를 삼키지 않는다
 * (던진 오류는 tenant() 가 받아 트랜잭션을 롤백한다). 사전 검사를 통과한 뒤에 DB가 거부하는 마지막 방어선용이다.
 *   23503 foreign_key_violation, 23514 check_violation 등
 */
export async function mapDbError<T>(p: Promise<T>, map: Partial<Record<string, () => HttpError>>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    const code = pgCode(err);
    const make = code ? map[code] : undefined;
    if (make) throw make();
    throw err;
  }
}
