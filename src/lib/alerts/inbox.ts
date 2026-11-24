// 알림함. 자기 알림만 읽고 읽음 처리한다. tenant() 트랜잭션 안에서 호출한다.
import type { Db } from '@/lib/db/context';
import type { Actor } from '@/lib/http/route';
import { runDailyAlerts } from './daily';

const SQL_INBOX_COUNTS =
  'SELECT count(*) FILTER (WHERE NOT $3::boolean OR read_at IS NULL)::int AS total, count(*) FILTER (WHERE read_at IS NULL)::int AS unread' +
  ' FROM app.notification WHERE company_id = $1 AND user_id = $2';
const SQL_INBOX_PAGE =
  'SELECT id, type, payload, read_at, created_at FROM app.notification' +
  ' WHERE company_id = $1 AND user_id = $2 AND (NOT $3::boolean OR read_at IS NULL)' +
  ' ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5';

// 메뉴의 읽지 않은 수 표시(badge)는 화면을 열 때마다 요청된다. 그때마다 날짜 기준 알림을 다시 계산하지 않도록,
// 그런 가벼운 요청에서는 기업마다 10분에 한 번만 계산한다(프로세스 안의 기억이라 재시작하면 다시 계산한다. 계산은 몇 번 해도 결과가 같다).
const LIGHT_INTERVAL_MS = 10 * 60 * 1000;
const lastDailyRun = new Map<string, number>();

export async function listAlerts(db: Db, actor: Actor, query: { unreadOnly?: boolean; page?: number; pageSize?: number; light?: boolean }) {
  const pageSize = Math.min(Math.max(query.pageSize ?? 30, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  // 날짜 기준 알림(보증 만료, 연체)은 알림함의 첫 쪽을 열 때 계산한다(이미 알린 건은 다시 만들어지지 않는다).
  const last = lastDailyRun.get(actor.companyId) ?? 0;
  if (page === 1 && (!query.light || Date.now() - last > LIGHT_INTERVAL_MS)) {
    await runDailyAlerts(db, actor.companyId);
    lastDailyRun.set(actor.companyId, Date.now());
  }
  const filters = [actor.companyId, actor.userId, query.unreadOnly ?? false];
  const counts = await db.query<{ total: number; unread: number }>(SQL_INBOX_COUNTS, filters);
  const rows = await db.query(SQL_INBOX_PAGE, [...filters, pageSize, (page - 1) * pageSize]);
  return { total: counts.rows[0]?.total ?? 0, unread: counts.rows[0]?.unread ?? 0, page, pageSize, items: rows.rows };
}
/** 읽음 처리. ids 가 없으면 전부. 남의 알림 ID 는 조용히 무시된다(자기 것만 바뀐다). */
export async function markAlertsRead(db: Db, actor: Actor, ids: string[] | null): Promise<number> {
  const result = await db.query(
    'UPDATE app.notification SET read_at = now() WHERE company_id = $1 AND user_id = $2 AND read_at IS NULL AND ($3::uuid[] IS NULL OR id = ANY($3))',
    [actor.companyId, actor.userId, ids],
  );
  return result.rowCount ?? 0;
}
