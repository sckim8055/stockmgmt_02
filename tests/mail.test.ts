// 4단계: 정기 메일 일정. 관리 규칙, 다음 발송 시각, 본문 내용(부서 제한·이스케이프), 범위·격리·권한.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as assetAssign } from '@/app/api/assets/[id]/assign/route';
import { POST as assetsCreate } from '@/app/api/assets/route';
import { GET as logsRoute } from '@/app/api/mail/logs/route';
import { POST as activateRoute } from '@/app/api/mail/schedules/[id]/activate/route';
import { POST as deactivateRoute } from '@/app/api/mail/schedules/[id]/deactivate/route';
import { GET as previewRoute } from '@/app/api/mail/schedules/[id]/preview/route';
import { DELETE as scheduleDelete, PATCH as schedulePatch } from '@/app/api/mail/schedules/[id]/route';
import { GET as schedulesList, POST as scheduleCreate } from '@/app/api/mail/schedules/route';
import { POST as issueRoute } from '@/app/api/peripherals/issue/route';
import { POST as receiveRoute } from '@/app/api/peripherals/receive/route';
import { POST as thresholdCreate } from '@/app/api/thresholds/route';
import { closePool } from '@/lib/db/pool';
import { call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

let A: TestCompany;
let B: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};
const userId: Record<string, string> = {};

type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });
const one = async (sql: string, params: unknown[]) => (await (await owner()).query(sql, params)).rows[0];
const post = (h: Handler, as: string, body: Record<string, unknown>) => call(h, { method: 'POST', cookie: cookie[as], body });
const postId = (h: Handler, as: string, v: string) => call(withId(h, v), { method: 'POST', cookie: cookie[as] });
const patch = (as: string, v: string, body: Record<string, unknown>) => call(withId(schedulePatch, v), { method: 'PATCH', cookie: cookie[as], body });

const MAIL_ACL: [string, string][] = ['read', 'create', 'update', 'delete', 'activate', 'deactivate'].map((op) => ['mail.schedule', op]);

async function userWith(loginId: string, acl: [string, string][], deptIds: string[] = [], email: string | null = `${loginId}@a.test`): Promise<void> {
  const o = await owner();
  const uid = await makeUser(A.id, loginId, 'COMPANY_USER');
  userId[loginId] = uid;
  await o.query('UPDATE app.app_user SET email = $2 WHERE id = $1', [uid, email]);
  const roleId = (await o.query('INSERT INTO app.role (company_id, name) VALUES ($1, $2) RETURNING id', [A.id, uniq('role')])).rows[0].id;
  for (const [r, op] of acl) await o.query('INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES ($1, $2, $3)', [roleId, r, op]);
  await o.query('INSERT INTO app.user_role (user_id, role_id, company_id) VALUES ($1, $2, $3)', [uid, roleId, A.id]);
  for (const d of deptIds) await o.query('INSERT INTO app.user_department_scope (user_id, department_id, company_id) VALUES ($1, $2, $3)', [uid, d, A.id]);
  cookie[loginId] = await sessionFor(A.code, loginId);
}

const body = (over: Record<string, unknown> = {}) => ({
  name: uniq('일정'), frequency: 'DAILY', sendTime: '09:00', timezone: 'Asia/Seoul', contentType: 'LOW_STOCK',
  recipients: { userIds: [], emails: ['ops@example.com'] }, ...over,
});

beforeAll(async () => {
  A = await makeCompany('MALA');
  B = await makeCompany('MALB');
  const o = await owner();
  const q = async (sql: string, p: unknown[]) => (await o.query(sql, p)).rows[0].id as string;
  id.it = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A.id])).rows[0].id;
  id.hr = await q("INSERT INTO app.department (company_id, name) VALUES ($1, 'HR <b>&') RETURNING id", [A.id]);
  id.bit = (await o.query('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [B.id])).rows[0].id;
  const acat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'Laptop') RETURNING id", [A.id]);
  const pcat = await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'Mouse') RETURNING id", [A.id]);
  await q("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'EmptyCat') RETURNING id", [A.id]);
  id.laptop = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Lenovo', 'X1') RETURNING id", [A.id, acat]);
  id.mouse = await q("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'Logi', '<script>alert(1)</script>') RETURNING id", [A.id, pcat]);
  id.p1 = await q("INSERT INTO app.person (company_id, name) VALUES ($1, 'Kim & Co') RETURNING id", [A.id]);
  cookie.admin = await sessionFor(A.code, 'admin');
  cookie.badmin = await sessionFor(B.code, 'admin');
  userId.badmin = (await one("SELECT id FROM app.app_user WHERE company_id = $1 AND login_id = 'admin'", [B.id])).id;
  await userWith('mailer', MAIL_ACL);
  await userWith('hrmailer', [...MAIL_ACL, ['mail.log', 'read']], [id.hr!]);
  await userWith('reader', [['mail.schedule', 'read']]);
  await userWith('nomail', [['asset.item', 'read']]);
  await userWith('noemail', [['asset.item', 'read']], [], null);

  // 자료: IT 에 자산 2대(1대 대여 중·연체), HR 에 마우스 5개(2개 대여), 마우스 한계 수량(HR) 부족 상태
  const mk = async (departmentId: string) => (await post(assetsCreate, 'admin', { modelId: id.laptop, assetTag: uniq('ML-'), departmentId, purchasePrice: 987654, supplier: 'SecretSupplier' })).data.assetId as string;
  await mk(id.it!);
  const lent = await mk(id.it!);
  await call(withId(assetAssign, lent), { method: 'POST', cookie: cookie.admin, body: { action: 'LOAN', holderPersonId: id.p1, dueDate: '2030-01-01' } });
  await o.query('UPDATE app.asset SET due_date = current_date - 2 WHERE id = $1', [lent]);
  const stock = (await post(receiveRoute, 'admin', { modelId: id.mouse, departmentId: id.hr, qty: 5 })).data.stockId;
  await post(issueRoute, 'admin', { action: 'LOAN', stockId: stock, personId: id.p1, qty: 2 });
  await post(thresholdCreate, 'admin', { modelId: id.mouse, departmentId: id.hr, minQty: 10 });
});
afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('일정 관리', () => {
  it('만들면 꺼진 상태이고, 받는 사람이 있어야 켤 수 있으며, 켜면 다음 발송 시각이 정해진다', async () => {
    const created = await post(scheduleCreate, 'admin', body({ recipients: { userIds: [], emails: [] } }));
    expect(created.status).toBe(201);
    const s = created.data.scheduleId as string;
    expect(await one('SELECT is_active, next_run_at FROM app.mail_schedule WHERE id = $1', [s])).toEqual({ is_active: false, next_run_at: null });
    expect((await postId(activateRoute, 'admin', s)).status).toBe(409);
    expect((await patch('admin', s, { recipients: { userIds: [userId.mailer], emails: ['Ops@Example.com', 'ops@example.com'] } })).status).toBe(200);
    expect((await postId(activateRoute, 'admin', s)).status).toBe(200);
    const row = await one("SELECT is_active, next_run_at, (next_run_at AT TIME ZONE 'Asia/Seoul')::time::text AS local, next_run_at > now() AS future, next_run_at < now() + interval '25 hours' AS soon FROM app.mail_schedule WHERE id = $1", [s]);
    expect(row).toMatchObject({ is_active: true, local: '09:00:00', future: true, soon: true });
    const listed = (await call(schedulesList, { cookie: cookie.admin })).data.schedules.find((x: { id: string }) => x.id === s);
    expect(listed.send_time).toBe('09:00');
    expect(listed.recipients.map((r: { email: string }) => r.email).sort()).toEqual(['mailer@a.test', 'ops@example.com']);
    // 켜진 일정의 받는 사람을 모두 지울 수 없다.
    expect((await patch('admin', s, { recipients: { userIds: [], emails: [] } })).status).toBe(409);
    // 시각을 바꾸면 다음 발송 시각도 바뀐다.
    await patch('admin', s, { sendTime: '18:30', timezone: 'UTC' });
    expect((await one("SELECT (next_run_at AT TIME ZONE 'UTC')::time::text AS t FROM app.mail_schedule WHERE id = $1", [s])).t).toBe('18:30:00');
    expect((await postId(deactivateRoute, 'admin', s)).status).toBe(200);
    expect((await one('SELECT next_run_at FROM app.mail_schedule WHERE id = $1', [s])).next_run_at).toBeNull();
  });

  it('주간·월간 일정의 다음 발송일은 고른 요일·날짜에 맞는다', async () => {
    const weekly = (await post(scheduleCreate, 'admin', body({ frequency: 'WEEKLY', days: [3, 3, 1] }))).data.scheduleId as string;
    await postId(activateRoute, 'admin', weekly);
    const w = await one("SELECT days, extract(isodow FROM next_run_at AT TIME ZONE timezone)::int AS dow, next_run_at < now() + interval '8 days' AS within FROM app.mail_schedule WHERE id = $1", [weekly]);
    expect(w.days).toEqual([1, 3]);
    expect([1, 3]).toContain(w.dow);
    expect(w.within).toBe(true);
    const monthly = (await post(scheduleCreate, 'admin', body({ frequency: 'MONTHLY', days: [15] }))).data.scheduleId as string;
    await postId(activateRoute, 'admin', monthly);
    expect((await one('SELECT extract(day FROM next_run_at AT TIME ZONE timezone)::int AS d FROM app.mail_schedule WHERE id = $1', [monthly])).d).toBe(15);
    // 31일만 고른 일정은 31일이 있는 달에 나간다.
    const day31 = (await post(scheduleCreate, 'admin', body({ frequency: 'MONTHLY', days: [31] }))).data.scheduleId as string;
    expect((await postId(activateRoute, 'admin', day31)).status).toBe(200);
    expect((await one('SELECT extract(day FROM next_run_at AT TIME ZONE timezone)::int AS d FROM app.mail_schedule WHERE id = $1', [day31])).d).toBe(31);
  });

  it('잘못된 입력은 거부한다', async () => {
    for (const over of [
      { frequency: 'WEEKLY' }, // 요일 없음
      { frequency: 'WEEKLY', days: [8] },
      { frequency: 'MONTHLY', days: [0] },
      { timezone: 'Mars/Olympus' },
      { sendTime: '24:00' },
      { sendTime: '9:00' },
      { contentType: 'EVERYTHING' },
      { recipients: { userIds: [], emails: ['not-an-email'] } },
      { recipients: { userIds: [userId.badmin], emails: [] } }, // 다른 기업 계정
      { recipients: { userIds: [userId.noemail], emails: [] } }, // 이메일 없는 계정
      { departmentId: id.bit }, // 다른 기업의 부서
      { companyId: B.id },
      { name: ' ' },
    ]) expect((await post(scheduleCreate, 'admin', body(over))).status, JSON.stringify(over)).toBe(400);
    expect((await post(scheduleCreate, 'admin', body({ recipients: { userIds: [], emails: Array.from({ length: 51 }, (_, i) => `u${i}@x.test`) } }))).status).toBe(400);
  });

  it('발송 기록이 있는 일정은 지울 수 없고, 없으면 받는 사람과 함께 지워진다', async () => {
    const s = (await post(scheduleCreate, 'admin', body())).data.scheduleId as string;
    const o = await owner();
    await o.query("INSERT INTO app.mail_job (company_id, schedule_id, scheduled_for) VALUES ($1, $2, now())", [A.id, s]);
    expect((await call(withId(scheduleDelete, s), { method: 'DELETE', cookie: cookie.admin })).status).toBe(409);
    const s2 = (await post(scheduleCreate, 'admin', body())).data.scheduleId as string;
    expect((await call(withId(scheduleDelete, s2), { method: 'DELETE', cookie: cookie.admin })).status).toBe(200);
    expect((await one('SELECT count(*)::int AS n FROM app.mail_recipient WHERE schedule_id = $1', [s2])).n).toBe(0);
  });
});

describe('본문', () => {
  const preview = async (as: string, over: Record<string, unknown>) => {
    const s = (await post(scheduleCreate, 'admin', body(over))).data.scheduleId as string;
    return call(withId(previewRoute, s), { cookie: cookie[as] });
  };

  it('재고 부족: 부족 상태인 한계 수량만 담고, 값은 HTML 에서 이스케이프된다', async () => {
    const r = await preview('admin', { contentType: 'LOW_STOCK' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ empty: false, rows: 1, subject: '[재고 부족 현황] 전체' });
    expect(r.data.text).toContain('Logi <script>alert(1)</script> | HR <b>& | 3 | 10');
    expect(r.data.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.data.html).not.toContain('<script>');
    expect(r.data.html).toContain('HR &lt;b&gt;&amp;');
    // IT 만 보는 일정에는 HR 의 부족 건이 없다.
    const it = await preview('admin', { contentType: 'LOW_STOCK', departmentId: id.it });
    expect(it.data).toMatchObject({ empty: true, rows: 0 });
    expect(it.data.text).not.toContain('Logi');
  });

  it('재고 현황: 카테고리별 수량. 부서 일정은 그 부서 것만. 제한 필드는 어디에도 없다', async () => {
    const all = await preview('admin', { contentType: 'STOCK_SUMMARY', lang: 'en' });
    expect(all.data.subject).toBe('[Stock summary] All');
    expect(all.data.text).toContain('Laptop | Asset | 1 | 1');
    expect(all.data.text).toContain('Mouse | Peripheral | 3 | 2');
    expect(all.data.text).not.toContain('EmptyCat');
    const hr = await preview('admin', { contentType: 'STOCK_SUMMARY', departmentId: id.hr });
    expect(hr.data.text).not.toContain('Laptop');
    expect(hr.data.text).toContain('Mouse | 주변기기 | 3 | 2');
    expect(JSON.stringify([all.data, hr.data])).not.toMatch(/987654|SecretSupplier/);
  });

  it('미반납 대여: 자산과 주변기기를 함께, 연체 표시, 부서 제한', async () => {
    const all = await preview('admin', { contentType: 'OPEN_LOANS', lang: 'zh' });
    expect(all.data.rows).toBe(2);
    expect(all.data.subject).toBe('[未归还借用] 全部');
    expect(all.data.text).toMatch(/Lenovo X1 \| Kim & Co \| 1 \| \d{4}-\d{2}-\d{2} \(逾期\)/);
    expect(all.data.html).toContain('Kim &amp; Co');
    const hr = await preview('admin', { contentType: 'OPEN_LOANS', departmentId: id.hr });
    expect(hr.data.rows).toBe(1);
    expect(hr.data.text).not.toContain('Lenovo');
    expect(JSON.stringify(all.data)).not.toMatch(/987654|SecretSupplier/);
  });
});

describe('범위·격리·권한', () => {
  it('범위가 제한된 사용자는 자기 부서의 일정만 보고 관리하며, 기업 전체 일정은 만들 수 없다', async () => {
    const company = (await post(scheduleCreate, 'admin', body())).data.scheduleId as string;
    const it = (await post(scheduleCreate, 'admin', body({ departmentId: id.it }))).data.scheduleId as string;
    expect((await post(scheduleCreate, 'hrmailer', body())).status).toBe(403);
    expect((await post(scheduleCreate, 'hrmailer', body({ departmentId: id.it }))).status).toBe(403);
    const hr = await post(scheduleCreate, 'hrmailer', body({ departmentId: id.hr, contentType: 'STOCK_SUMMARY' }));
    expect(hr.status).toBe(201);
    const seen = (await call(schedulesList, { cookie: cookie.hrmailer })).data.schedules.map((s: { id: string }) => s.id);
    expect(seen).toContain(hr.data.scheduleId);
    expect(seen).not.toContain(company);
    expect(seen).not.toContain(it);
    for (const s of [company, it]) {
      expect((await patch('hrmailer', s, { name: 'x' })).status).toBe(404);
      expect((await postId(activateRoute, 'hrmailer', s)).status).toBe(404);
      expect((await postId(deactivateRoute, 'hrmailer', s)).status).toBe(404);
      expect((await call(withId(previewRoute, s), { cookie: cookie.hrmailer })).status).toBe(404);
      expect((await call(withId(scheduleDelete, s), { method: 'DELETE', cookie: cookie.hrmailer })).status).toBe(404);
    }
    // 자기 일정의 미리보기에는 자기 부서 자료만 있다.
    const own = await call(withId(previewRoute, hr.data.scheduleId), { cookie: cookie.hrmailer });
    expect(own.data.text).toContain('Mouse');
    expect(own.data.text).not.toContain('Laptop');
    // 부서를 바꾸는 요청은 받지 않는다(범위 밖으로 넓힐 수 없다).
    expect((await patch('hrmailer', hr.data.scheduleId, { departmentId: null })).status).toBe(400);
    expect((await patch('hrmailer', hr.data.scheduleId, { departmentId: id.it })).status).toBe(400);
    // 발송 기록은 범위 제한이 없는 사용자만.
    expect((await call(logsRoute, { cookie: cookie.hrmailer })).status).toBe(403);
    expect((await call(logsRoute, { cookie: cookie.admin })).status).toBe(200);
    expect((await call(logsRoute, { cookie: cookie.mailer })).status).toBe(403); // mail.log 권한 없음
  });

  it('다른 기업의 일정은 찾을 수 없고, 권한이 없으면 거부된다', async () => {
    const s = (await post(scheduleCreate, 'admin', body())).data.scheduleId as string;
    expect((await call(withId(schedulePatch, s), { method: 'PATCH', cookie: cookie.badmin, body: { name: 'x' } })).status).toBe(404);
    expect((await call(withId(previewRoute, s), { cookie: cookie.badmin })).status).toBe(404);
    expect((await call(withId(activateRoute, s), { method: 'POST', cookie: cookie.badmin })).status).toBe(404);
    expect((await call(withId(scheduleDelete, s), { method: 'DELETE', cookie: cookie.badmin })).status).toBe(404);
    expect((await call(schedulesList, { cookie: cookie.badmin })).data.schedules).toEqual([]);
    expect((await call(schedulesList, { cookie: cookie.nomail })).status).toBe(403);
    expect((await post(scheduleCreate, 'reader', body())).status).toBe(403);
    expect((await patch('reader', s, { name: 'x' })).status).toBe(403);
    expect((await postId(activateRoute, 'reader', s)).status).toBe(403);
    expect((await call(withId(scheduleDelete, s), { method: 'DELETE', cookie: cookie.reader })).status).toBe(403);
    expect((await call(withId(previewRoute, s), { cookie: cookie.reader })).status).toBe(200);
    expect((await call(schedulesList)).status).toBe(401);
  });
});

describe('검토에서 드러난, 테스트가 없던 보장', () => {
  it('받는 사람: 비활성 계정은 고를 수 없고, 계정과 주소를 합쳐 50명까지다', async () => {
    const o = await owner();
    await userWith('gone', [['asset.item', 'read']]);
    await o.query('UPDATE app.app_user SET is_active = false WHERE id = $1', [userId.gone]);
    expect((await post(scheduleCreate, 'admin', body({ recipients: { userIds: [userId.gone], emails: [] } }))).status).toBe(400);
    const fifty = Array.from({ length: 50 }, (_, i) => `r${i}@x.test`);
    expect((await post(scheduleCreate, 'admin', body({ recipients: { userIds: [userId.mailer], emails: fifty } }))).status).toBe(400);
    expect((await post(scheduleCreate, 'admin', body({ recipients: { userIds: [userId.mailer], emails: fifty.slice(1) } }))).status).toBe(201);
  });

  it('미반납 대여: 부서 일정에는 다른 부서의 주변기기 대여가 들어가지 않는다', async () => {
    const o = await owner();
    const person = (await o.query("INSERT INTO app.person (company_id, name) VALUES ($1, 'OtherDeptHolder') RETURNING id", [A.id])).rows[0].id;
    const stock = (await post(receiveRoute, 'admin', { modelId: id.mouse, departmentId: id.it, qty: 3 })).data.stockId;
    await post(issueRoute, 'admin', { action: 'LOAN', stockId: stock, personId: person, qty: 1 });
    const s = (await post(scheduleCreate, 'admin', body({ contentType: 'OPEN_LOANS', departmentId: id.hr }))).data.scheduleId as string;
    const hr = await call(withId(previewRoute, s), { cookie: cookie.admin });
    expect(hr.data.text).not.toContain('OtherDeptHolder');
    const all = (await post(scheduleCreate, 'admin', body({ contentType: 'OPEN_LOANS' }))).data.scheduleId as string;
    expect((await call(withId(previewRoute, all), { cookie: cookie.admin })).data.text).toContain('OtherDeptHolder');
  });

  it('받는 사람 주소는 감사 로그에 남는다', async () => {
    const s = (await post(scheduleCreate, 'admin', body({ recipients: { userIds: [userId.mailer], emails: ['Out@External.example'] } }))).data.scheduleId as string;
    const audit = await one("SELECT after FROM app.audit_log WHERE target_id = $1 AND action = 'MAIL_SCHEDULE_CREATED'", [s]);
    expect(audit.after.recipients).toEqual({ userIds: [userId.mailer], emails: ['out@external.example'] });
  });
});
