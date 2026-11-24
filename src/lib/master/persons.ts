// 직원 명부(자산 보유자). 로그인 계정이 아니다. 모든 함수는 tenant() 트랜잭션 안에서 호출한다.
//
// 규칙
//  - 직원 명부는 기업 전체의 것이라 부서 범위로 제한하지 않는다.
//  - 응답에는 정해진 컬럼(PERSON_COLUMNS)만 싣는다.
//  - 사번은 있으면 기업 안에서 고유하다(대소문자 무시). 비활성(퇴사) 직원의 사번도 다시 쓸 수 없다.
//  - 퇴사 처리(비활성화)는 자산을 보유 중이거나(상태 무관) 반납하지 않은 주변기기 대여가 있으면 거부한다.
//  - 익명화는 비활성 직원에게만, 되돌릴 수 없다. 이름·사번·이메일은 감사 로그에도 남기지 않는다
//    (감사 로그는 고칠 수 없으므로, 처음부터 개인정보를 싣지 않아야 익명화 후에 남지 않는다).
import type { Db } from '@/lib/db/context';
import { writeAudit } from '@/lib/auth/audit';
import { badRequest, notFound } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { conflict, likePattern, lockMasterData } from './common';

const RESOURCE = 'master.person';

export interface PersonRow {
  id: string;
  employee_no: string | null;
  name: string;
  department_id: string | null;
  department_name: string | null;
  email: string | null;
  is_active: boolean;
  anonymized_at: string | null;
}

// 응답 컬럼은 이 목록뿐이다.
const SQL_PERSON_COLUMNS =
  ' p.id, p.employee_no, p.name, p.department_id, d.name AS department_name, p.email, p.is_active, p.anonymized_at ';
const SQL_PERSON_FROM = ' FROM app.person p LEFT JOIN app.department d ON d.id = p.department_id AND d.company_id = p.company_id ';
const SQL_PERSON_FILTERS =
  ' WHERE p.company_id = $1' +
  ' AND ($2::text IS NULL OR p.name ILIKE $2 OR p.employee_no ILIKE $2 OR p.email ILIKE $2)' +
  ' AND ($3::uuid IS NULL OR p.department_id = $3)' +
  ' AND ($4::boolean OR p.is_active) ';
const SQL_PERSON_COUNT = 'SELECT count(*)::int AS n' + SQL_PERSON_FROM + SQL_PERSON_FILTERS;
const SQL_PERSON_PAGE =
  'SELECT' + SQL_PERSON_COLUMNS + SQL_PERSON_FROM + SQL_PERSON_FILTERS + ' ORDER BY lower(p.name), p.id LIMIT $5 OFFSET $6';

export interface PersonListQuery {
  q?: string;
  departmentId?: string;
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listPersons(db: Db, actor: Actor, query: PersonListQuery): Promise<{ total: number; page: number; pageSize: number; items: PersonRow[] }> {
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const q = query.q?.trim();
  const filters = [actor.companyId, q ? likePattern(q) : null, query.departmentId ?? null, query.includeInactive ?? false];
  const count = await db.query<{ n: number }>(SQL_PERSON_COUNT, filters);
  const rows = await db.query<PersonRow>(SQL_PERSON_PAGE, [...filters, pageSize, (page - 1) * pageSize]);
  return { total: count.rows[0]?.n ?? 0, page, pageSize, items: rows.rows };
}

interface LockedPerson {
  id: string;
  employee_no: string | null;
  department_id: string | null;
  email: string | null;
  is_active: boolean;
  anonymized_at: string | null;
}

/**
 * 자기 기업의 직원을 잠그고 읽는다. 다른 기업의 직원은 없는 것으로 응답한다.
 * FOR UPDATE: 퇴사 처리 중에 이 직원을 참조하는 새 행(자산 배정·대여)의 외래키 검사가 기다리게 한다.
 */
async function lockPerson(db: Db, actor: Actor, personId: string): Promise<LockedPerson> {
  await lockMasterData(db, actor.companyId);
  const { rows } = await db.query<LockedPerson>(
    'SELECT id, employee_no, department_id, email, is_active, anonymized_at FROM app.person WHERE id = $1 AND company_id = $2 FOR UPDATE',
    [personId, actor.companyId],
  );
  const person = rows[0];
  if (!person) throw notFound();
  return person;
}

/** 활성 부서인지 확인한다. FOR SHARE: 확인과 저장 사이에 부서가 비활성화되지 않게 한다. */
async function assertActiveDepartment(db: Db, actor: Actor, departmentId: string): Promise<void> {
  const { rowCount } = await db.query('SELECT 1 FROM app.department WHERE id = $1 AND company_id = $2 AND is_active FOR SHARE', [
    departmentId,
    actor.companyId,
  ]);
  if (!rowCount) throw badRequest('선택할 수 없는 부서입니다.');
}

async function assertEmployeeNoFree(db: Db, actor: Actor, employeeNo: string, exceptId: string | null): Promise<void> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM app.person WHERE company_id = $1 AND lower(employee_no) = lower($2) AND ($3::uuid IS NULL OR id <> $3)',
    [actor.companyId, employeeNo, exceptId],
  );
  // 퇴사자의 사번과 겹쳐도 같은 응답이다. 사번은 재사용하지 않는다.
  if (rowCount) throw conflict('DUPLICATE', '이미 사용 중인(또는 과거에 사용한) 사번입니다.');
}

export interface PersonInput {
  employeeNo?: string | null;
  name: string;
  departmentId?: string | null;
  email?: string | null;
}

/** 감사 로그에는 바뀐 항목의 이름만 남긴다(개인정보 값은 남기지 않는다). */
const changedFields = (input: object) => Object.entries(input).filter(([, v]) => v !== undefined).map(([k]) => k);

export async function createPerson(db: Db, actor: Actor, input: PersonInput): Promise<string> {
  await lockMasterData(db, actor.companyId);
  const employeeNo = input.employeeNo || null;
  if (input.departmentId) await assertActiveDepartment(db, actor, input.departmentId);
  if (employeeNo) await assertEmployeeNoFree(db, actor, employeeNo, null);
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO app.person (company_id, employee_no, name, department_id, email) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [actor.companyId, employeeNo, input.name, input.departmentId || null, input.email || null],
  );
  const id = rows[0]!.id;
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'PERSON_CREATED', resource: RESOURCE, targetId: id,
    after: { fields: changedFields(input), departmentId: input.departmentId || null }, ip: actor.auditIp,
  });
  return id;
}

const anonymizedLocked = () => conflict('ANONYMIZED', '익명화된 직원은 수정하거나 다시 활성화할 수 없습니다.');

export async function updatePerson(db: Db, actor: Actor, personId: string, input: Partial<PersonInput>): Promise<void> {
  const person = await lockPerson(db, actor, personId);
  if (person.anonymized_at) throw anonymizedLocked();
  if (changedFields(input).length === 0) return;
  const departmentChanged = input.departmentId !== undefined && (input.departmentId || null) !== person.department_id;
  if (departmentChanged && input.departmentId) await assertActiveDepartment(db, actor, input.departmentId);
  const employeeNo = input.employeeNo === undefined ? person.employee_no : input.employeeNo || null;
  if (employeeNo && employeeNo !== person.employee_no) await assertEmployeeNoFree(db, actor, employeeNo, person.id);
  await db.query(
    `UPDATE app.person
        SET employee_no = $2,
            name = coalesce($3, name),
            department_id = CASE WHEN $4::boolean THEN $5::uuid ELSE department_id END,
            email = CASE WHEN $6::boolean THEN $7 ELSE email END
      WHERE id = $1 AND company_id = $8`,
    [
      person.id, employeeNo, input.name ?? null,
      departmentChanged, input.departmentId || null,
      input.email !== undefined, input.email || null,
      actor.companyId,
    ],
  );
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'PERSON_UPDATED', resource: RESOURCE, targetId: person.id,
    before: departmentChanged ? { departmentId: person.department_id } : undefined,
    after: { fields: changedFields(input), departmentId: departmentChanged ? input.departmentId || null : undefined },
    ip: actor.auditIp,
  });
}

export interface Holding {
  assets: number;
  openLoans: number;
}

const SQL_PERSON_HOLDING =
  'SELECT (SELECT count(*)::int FROM app.asset WHERE company_id = $2 AND holder_person_id = $1) AS assets,' +
  ` (SELECT count(*)::int FROM app.peripheral_loan WHERE company_id = $2 AND person_id = $1 AND status = 'OPEN') AS open_loans`;

/** 퇴사 처리 결과. 보유 중인 것이 있으면 처리하지 않고 그 수를 돌려준다. */
export type DeactivateResult = { ok: true } | { ok: false; holding: Holding };

export async function setPersonActive(db: Db, actor: Actor, personId: string, active: boolean): Promise<DeactivateResult> {
  const person = await lockPerson(db, actor, personId);
  if (active && person.anonymized_at) throw anonymizedLocked();
  if (person.is_active === active) return { ok: true };
  if (!active) {
    const h = (await db.query<{ assets: number; open_loans: number }>(SQL_PERSON_HOLDING, [person.id, actor.companyId])).rows[0]!;
    if (h.assets > 0 || h.open_loans > 0) return { ok: false, holding: { assets: h.assets, openLoans: h.open_loans } };
  }
  await db.query('UPDATE app.person SET is_active = $2 WHERE id = $1 AND company_id = $3', [person.id, active, actor.companyId]);
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: active ? 'PERSON_ACTIVATED' : 'PERSON_DEACTIVATED',
    resource: RESOURCE, targetId: person.id, ip: actor.auditIp,
  });
  return { ok: true };
}

/**
 * 익명화: 이름을 "퇴사자-<ID 앞 8자리>"로 바꾸고 사번·이메일을 지운다. 되돌릴 수 없다.
 * 자산 이력(asset_txn)은 직원을 ID로만 참조하므로 이력의 이름 표시도 함께 익명화된다.
 */
export async function anonymizePerson(db: Db, actor: Actor, personId: string): Promise<void> {
  const person = await lockPerson(db, actor, personId);
  if (person.anonymized_at) throw conflict('ANONYMIZED', '이미 익명화된 직원입니다.');
  if (person.is_active) throw conflict('ACTIVE', '재직 중인(활성) 직원은 익명화할 수 없습니다. 먼저 퇴사 처리(비활성화)하세요.');
  await db.query(
    `UPDATE app.person
        SET name = '퇴사자-' || left(id::text, 8), employee_no = NULL, email = NULL, anonymized_at = now()
      WHERE id = $1 AND company_id = $2`,
    [person.id, actor.companyId],
  );
  await writeAudit(db, {
    companyId: actor.companyId, actorId: actor.userId, action: 'PERSON_ANONYMIZED', resource: RESOURCE, targetId: person.id,
    after: { anonymized: true }, ip: actor.auditIp,
  });
}
