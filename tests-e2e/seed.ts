// 화면 점검용 시드: 기업 2개, 계정·역할·부서 범위, 부서(HR), 직원 2명. 업무 자료는 smoke.py 가 API 로 만든다.
// 실행: (cwd = 저장소) DATABASE_URL=<앱 역할> OWNER_URL=<소유자> SMOKE_PW=<사용자 비밀번호> npx tsx tests-e2e/seed.ts
// 비밀번호는 환경변수로만 받고 어디에도 쓰지 않는다. 출력은 ID 만 담은 JSON.
import pg from 'pg';
import { createCompany } from '@/lib/company/create';
import { hashPassword } from '@/lib/auth/password';
import { closePool } from '@/lib/db/pool';

const pw = process.env.SMOKE_PW!;
const o = new pg.Client({ connectionString: process.env.OWNER_URL });

async function company(code: string) {
  const r = await createCompany({ code, name: `${code} Inc`, locale: 'ko', admin: { loginId: 'admin', displayName: 'Admin' } }, { userId: null });
  await o.query('UPDATE app.app_user SET password_hash = $2, must_change_password = false, temp_password_expires_at = NULL WHERE id = $1', [r.adminUserId, await hashPassword(pw)]);
  return r.companyId;
}

async function user(companyId: string, loginId: string, acl: [string, string][] | string, depts: string[] = [], lang = 'ko') {
  const uid = (await o.query(
    `INSERT INTO app.app_user (company_id, login_id, password_hash, display_name, user_type, must_change_password, lang)
     VALUES ($1, $2, $3, $4, 'COMPANY_USER', false, $5) RETURNING id`,
    [companyId, loginId, await hashPassword(pw), `User ${loginId}`, lang],
  )).rows[0].id as string;
  let roleId: string;
  if (typeof acl === 'string') roleId = (await o.query('SELECT id FROM app.role WHERE company_id = $1 AND name = $2', [companyId, acl])).rows[0].id;
  else {
    roleId = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [companyId, `role-${loginId}`])).rows[0].id;
    for (const [r, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [roleId, r, op]);
  }
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [uid, roleId, companyId]);
  for (const d of depts) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [uid, d, companyId]);
  return uid;
}

async function main() {
  await o.connect();
  const A = await company('SMOKEA');
  const B = await company('SMOKEB');
  const it = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A])).rows[0].id;
  const hr = (await o.query("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR') RETURNING id", [A])).rows[0].id;
  const kim = (await o.query("INSERT INTO app.person (company_id, name, employee_no) VALUES ($1, 'Kim', 'E001') RETURNING id", [A])).rows[0].id;
  const lee = (await o.query("INSERT INTO app.person (company_id, name, employee_no) VALUES ($1, 'Lee', 'E002') RETURNING id", [A])).rows[0].id;
  const out = {
    A, B, it, hr, kim, lee,
    viewer: await user(A, 'viewer', 'Viewer'),
    hrmanager: await user(A, 'hrmanager', 'Stock Manager', [hr]),
    dashonly: await user(A, 'dashonly', [['dashboard', 'read']]),
    hraudit: await user(A, 'hraudit', [['history.audit', 'read'], ['history.stock', 'read'], ['dashboard', 'read']], [hr]),
    zhuser: await user(A, 'zhuser', 'Viewer', [], 'zh'),
  };
  console.log(JSON.stringify(out));
}

main().finally(async () => {
  await o.end();
  await closePool();
});
