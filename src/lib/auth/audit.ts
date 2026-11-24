import type { Db } from '@/lib/db/context';

export interface AuditEntry {
  companyId: string | null;
  actorId: string | null;
  action: string;
  resource?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** 감사 로그는 추가만 한다. 비밀번호·토큰 같은 비밀값을 before/after 에 넣지 않는다. */
export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO app.audit_log (company_id, actor_id, action, resource, target_id, before, after, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.companyId,
      e.actorId,
      e.action,
      e.resource ?? null,
      e.targetId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.ip ?? null,
    ],
  );
}
