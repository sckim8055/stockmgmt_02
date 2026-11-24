// "오늘"은 기업의 시간대로 정한다(DB 서버의 날짜가 아니다). 연체·보증 만료처럼 날짜로 판정하는 모든 곳이 쓴다.
import type { Db } from '@/lib/db/context';

/** 기업 시간대의 오늘 날짜(YYYY-MM-DD). tenant() 트랜잭션 안에서 호출한다. */
export async function companyToday(db: Db, companyId: string): Promise<string> {
  const { rows } = await db.query<{ today: string }>('SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM app.company WHERE id = $1', [companyId]);
  // 시스템 관리자가 기업을 고르지 않은 경우 등 기업 행이 없으면 UTC 날짜를 쓴다.
  return rows[0]?.today ?? new Date().toISOString().slice(0, 10);
}
