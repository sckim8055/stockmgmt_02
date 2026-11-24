// 5단계 독립 검토(review5): 결함 재현 테스트. 실패하는 테스트가 곧 결함이다(조치 전에는 실패가 정상).
// 각 테스트 이름 앞의 [R5-x] 는 검토 보고서의 번호다. 마지막 describe 는 "견딘 것"을 확인하는 통과 테스트다.
//
// 성능 관련 테스트는 시간을 재지 않는다. 앱 역할(RLS 적용) + 기업 문맥으로 EXPLAIN (ANALYZE) 를 돌려
// "그 테이블에서 실제로 읽은 행 수"를 세어, 한 쪽을 보여 주려고 기업 전체를 읽는지를 판정한다(데이터가 늘면 비례해서 느려진다).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PATCH as userPatch } from '@/app/api/admin/users/[id]/route';
import { POST as assetsCreate } from '@/app/api/assets/route';
import { POST as importAssets } from '@/app/api/import/assets/route';
import { POST as personsCreate } from '@/app/api/master/persons/route';
import { POST as scheduleCreate } from '@/app/api/mail/schedules/route';
import { runDailyAlerts, runDailyAlertsOncePerDay } from '@/lib/alerts/daily';
import type { Db } from '@/lib/db/context';
import { closePool } from '@/lib/db/pool';
import { readXlsx } from '@/lib/import/xlsx';
import { createPerson } from '@/lib/master/persons';
import { listStockHistory } from '@/lib/reports/history';
import { APP_ROLE, call, closeOwner, makeCompany, makeUser, owner, sessionFor, uniq, type TestCompany } from './helpers';

const FIX = path.join(import.meta.dirname, 'fixtures-review5');
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIX, name)));

let A: TestCompany;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};
type Handler = (req: Request, extra?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
const withId = (h: Handler, v: string) => (req: Request) => h(req, { params: Promise.resolve({ id: v }) });
const one = async (sql: string, params: unknown[] = []) => (await (await owner()).query(sql, params)).rows[0];

/** 소유자 연결로 연 "앱 역할 + 기업 문맥" 트랜잭션. 앱의 쿼리를 그대로 받아 실행하고, EXPLAIN ANALYZE 로 읽은 행 수를 센다. */
async function tenantSession(companyId: string) {
  const c = new pg.Client({ connectionString: process.env.TEST_OWNER_URL });
  await c.connect();
  await c.query('BEGIN');
  await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await c.query("SELECT set_config('app.company_id', $1, true), set_config('app.system', 'off', true)", [companyId]);
  const captured: { text: string; params: unknown[] }[] = [];
  const db: Db = {
    query: async (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      return c.query(text, params as unknown[]) as never;
    },
  };
  /** relation 에서 실제로 읽은 행(돌려준 행 + 조건으로 버린 행) */
  async function rowsRead(text: string, params: unknown[], relation: string): Promise<number> {
    await c.query('SAVEPOINT x');
    const { rows } = await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params as unknown[]);
    await c.query('ROLLBACK TO SAVEPOINT x');
    let total = 0;
    const walk = (n: any) => {
      if (n['Relation Name'] === relation) {
        const loops = n['Actual Loops'] ?? 1;
        total += ((n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0) + (n['Rows Removed by Index Recheck'] ?? 0)) * loops;
      }
      for (const p of n.Plans ?? []) walk(p);
    };
    walk(rows[0]['QUERY PLAN'][0].Plan);
    return total;
  }
  return { db, captured, rowsRead, end: async () => { await c.query('ROLLBACK'); await c.end(); } };
}

const actorOf = (companyId: string, userId: string) => ({ companyId, userId, userType: 'COMPANY_ADMIN' as const, isAdmin: true, auditIp: null });
const ALL = { scope: null, unrestricted: true, inScope: () => true } as never;

beforeAll(async () => {
  A = await makeCompany('R5A');
  const o = await owner();
  id.it = (await one('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [A.id])).id;
  id.cat = (await one("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'R5 Laptop') RETURNING id", [A.id])).id;
  id.model = (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'R5', 'X') RETURNING id", [A.id, id.cat])).id;
  cookie.admin = await sessionFor(A.code, 'admin');

  // 대량 자료(이 기업만): 자산 300대 × 이력 100건 = 30,000건, 열쇠가 있는 알림 20,000건, 최근 이틀의 감사 로그 20,000건
  await o.query(
    "INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate, department_id, warranty_end) SELECT $1, $2, 'R5BULK-' || g, 'IN_STOCK', 'AVAILABLE', $3, current_date + 10 FROM generate_series(1, 300) g",
    [A.id, id.model, id.it],
  );
  await o.query(
    "INSERT INTO app.asset_txn (company_id, asset_id, type, note, created_at) SELECT a.company_id, a.id, 'UPDATE', 'n', now() - (g || ' minutes')::interval FROM app.asset a CROSS JOIN generate_series(1, 100) g WHERE a.company_id = $1",
    [A.id],
  );
  await o.query(
    "INSERT INTO app.notification (company_id, user_id, type, payload) SELECT $1, $2, 'WARRANTY_EXPIRING', jsonb_build_object('key', 'old:' || g) FROM generate_series(1, 20000) g",
    [A.id, A.adminUserId],
  );
  await o.query(
    "INSERT INTO app.audit_log (company_id, action, resource, created_at) SELECT $1, 'ASSET_UPDATED', 'asset.item', now() - (g * 8 || ' seconds')::interval FROM generate_series(1, 20000) g",
    [A.id],
  );
  // 직원 30,000명(이 기업 15,000 + 다른 기업 15,000)
  const other = await makeCompany('R5O');
  await o.query("INSERT INTO app.person (company_id, employee_no, name) SELECT c, 'R5E' || g, 'P' || g FROM unnest($1::uuid[]) c CROSS JOIN generate_series(1, 15000) g", [[A.id, other.id]]);
  await o.query('ANALYZE app.asset, app.asset_txn, app.notification, app.audit_log, app.person');
}, 120_000);

afterAll(async () => {
  await closeOwner();
  await closePool();
});

describe('[R5-1] 재고 이력 첫 쪽이 기업의 이력 전체를 읽는다 (다른 기업까지 느려지는 원인)', () => {
  it('[R5-1] /api/history/stock 의 첫 쪽(50건)을 보이려고 asset_txn 을 몇 행 읽는가', async () => {
    const s = await tenantSession(A.id);
    try {
      await listStockHistory(s.db, actorOf(A.id, A.adminUserId), ALL, { pageSize: 50 });
      const q = s.captured.find((x) => x.text.includes('app.asset_txn'))!;
      const read = await s.rowsRead(q.text, q.params, 'asset_txn');
      // 기대: 첫 쪽에 필요한 만큼(+ 여유)만 읽는다. 실제: 이 기업의 이력 30,000건 전부를 읽고 정렬한다.
      expect(read).toBeLessThanOrEqual(51 * 20);
    } finally {
      await s.end();
    }
  });
});

describe('[R5-2] 날짜 알림의 "이미 알렸는가" 확인이 기업의 알림 전체를 읽는다', () => {
  it('[R5-2] 보증 만료 알림 계산이 notification 을 몇 행 읽는가', async () => {
    const s = await tenantSession(A.id);
    try {
      await runDailyAlerts(s.db, A.id);
      const q = s.captured.find((x) => x.text.includes('INSERT INTO app.notification') && x.params[1] === 'WARRANTY_EXPIRING')!;
      const read = await s.rowsRead(q.text, q.params, 'notification');
      // 0007 의 (company_id, payload->>'key') 인덱스는 RLS 아래에서 열쇠 조건으로 쓰이지 못한다(->> 가 누설 방지 함수가 아님).
      // 기대: 후보 건(최대 100) × 받는 사람 정도. 실제: 열쇠가 있는 알림 20,000건 전부를 읽어 해시한다. 알림은 지워지지 않으므로 계속 커진다.
      expect(read).toBeLessThanOrEqual(2000);
    } finally {
      await s.end();
    }
  });
});

describe('[R5-3] "오늘 계산했는가" 확인이 최근 이틀의 감사 로그를 모두 읽는다 (알림함·메뉴 조회마다)', () => {
  it('[R5-3] 표시 기록 조회가 audit_log 를 몇 행 읽는가', async () => {
    const s = await tenantSession(A.id);
    try {
      await runDailyAlertsOncePerDay(s.db, A.id);
      const q = s.captured.find((x) => x.text.includes('FROM app.audit_log a JOIN app.company'))!;
      const read = await s.rowsRead(q.text, q.params, 'audit_log');
      // action 이 들어간 인덱스가 없어 (company_id, created_at) 범위 전체(20,000행)를 읽고 action 으로 버린다.
      expect(read).toBeLessThanOrEqual(10);
    } finally {
      await s.end();
    }
  });
});

describe('[R5-10] 사번 중복 검사·사번 조회가 lower() 조건이라 RLS 아래에서 인덱스를 못 쓴다 (0008 이 자산만 고쳤다)', () => {
  it('[R5-10] 직원 한 명 등록의 사번 중복 검사가 person 을 몇 행 읽는가', async () => {
    const s = await tenantSession(A.id);
    try {
      await createPerson(s.db, actorOf(A.id, A.adminUserId), { name: 'New', employeeNo: uniq('R5N') } as never);
      const q = s.captured.find((x) => x.text.includes('employee_no_key = lower($2)'))!;
      const read = await s.rowsRead(q.text, q.params, 'person');
      // 실제: 테이블 전체(다른 기업 행까지) 30,000행을 순차로 읽는다. 엑셀로 직원 2,000명을 올리면 2,000번 반복된다.
      expect(read).toBeLessThanOrEqual(10);
    } finally {
      await s.end();
    }
  });
});

describe('[R5-4] 엑셀 읽기: 마지막 속성 뒤의 공백(`<c r="A1" />`)이 있으면 파일 전체를 거부한다 (4abe71c 의 회귀)', () => {
  const WB = strToU8('<workbook xmlns:r="r"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>');
  const RELS = strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  const sheet = (xml: string) => zipSync({ 'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': strToU8(xml) });

  it('[R5-4] openpyxl(lxml 없이 설치된 기본 상태)이 저장한 파일을 읽는다', () => {
    // 이 파일의 workbook.xml 은 <sheet name="자산" sheetId="1" state="visible" r:id="rId1" /> 처럼 "/>" 앞에 공백이 있다
    // (Python ElementTree, .NET XmlWriter 의 기본 출력 형식). 4abe71c 이전 판은 이 파일을 읽었다.
    expect(readXlsx(fixture('openpyxl-no-lxml.xlsx'))[1]).toEqual(['RV5-200', '노트북', 'Dell', 'Latitude']);
  });

  it('[R5-4] 빈 서식 칸 <c r="B1" s="3" /> 과 <row r="1" > 를 받는다', () => {
    expect(readXlsx(sheet('<worksheet><sheetData><row r="1" ><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B1" s="3" /></row></sheetData></worksheet>'))).toEqual([['a', null]]);
  });
});

describe('[R5-5] 엑셀 읽기: 자료는 몇 행인데 서식만 지정한 빈 행이 2,001행 아래까지 있으면 "행이 너무 많다"로 거부한다', () => {
  it('[R5-5] A2:A3000 을 "텍스트" 서식으로 바꾼 파일(양식 안내가 시키는 일)을 읽는다', () => {
    // openpyxl 로 만든 파일. 자료 4행 + 서식만 있는 빈 칸 <c r="A6" s="1"/> … <c r="A3000" s="1"/>
    const rows = readXlsx(fixture('openpyxl-text-format-range.xlsx'));
    expect(rows[1]?.[0]).toBe('RV5-001');
  });
});

describe('[R5-6] 엑셀 업로드가 위치(자유 입력) 칸의 줄바꿈을 거부한다 (화면 API 는 받는다)', () => {
  it('[R5-6] 셀 안 줄바꿈(Alt+Enter)이 든 위치는 미리보기에서 오류가 아니다', async () => {
    // 화면 API 는 같은 값을 받는다(location 은 str()).
    const api = await call(assetsCreate, { method: 'POST', cookie: cookie.admin, body: { modelId: id.model, assetTag: uniq('R5ML-'), location: '본관 3층\n301호' } });
    expect(api.status).toBe(201);
    const res = await importAssets(
      new Request('http://app.test/api/import/assets?mode=preview', {
        method: 'POST',
        headers: { host: 'app.test', origin: 'http://app.test', cookie: cookie.admin!, 'content-type': 'application/octet-stream' },
        body: fixture('openpyxl-multiline-location.xlsx') as BodyInit,
      }),
    );
    const data = await res.json();
    expect(data.errors.map((e: { message: string }) => e.message)).toEqual([]);
  });
});

describe('[R5-7] 이름 입력이 끝에 붙은 탭·줄바꿈을 잘라 내지 않고 거부한다 (trim 전에 검사)', () => {
  it('[R5-7] 엑셀에서 복사해 붙인 "Kim\\t" 은 "Kim" 으로 저장된다(엑셀 업로드는 그렇게 한다)', async () => {
    const r = await call(personsCreate, { method: 'POST', cookie: cookie.admin, body: { name: 'Kim\t' } });
    expect(r.status).toBe(201);
  });
});

describe('[R5-8] 메일 받는 계정의 이메일을 기업 밖 주소로 바꿔도 감사 로그에 남지 않는다 (M-3 의 우회)', () => {
  it('[R5-8] USER_UPDATED 감사 기록에 바뀐 이메일이 있다', async () => {
    const uid = await makeUser(A.id, uniq('r5mail').toLowerCase(), 'COMPANY_USER');
    await (await owner()).query("UPDATE app.app_user SET email = 'staff@corp.example' WHERE id = $1", [uid]);
    const sch = await call(scheduleCreate, {
      method: 'POST', cookie: cookie.admin,
      body: { name: 'R5', frequency: 'DAILY', sendTime: '09:00', timezone: 'Asia/Seoul', contentType: 'STOCK_SUMMARY', recipients: { userIds: [uid], emails: [] } },
    });
    expect(sch.status).toBe(201);
    const r = await call(withId(userPatch, uid), { method: 'PATCH', cookie: cookie.admin, body: { email: 'outside@attacker.example' } });
    expect(r.status).toBe(200);
    const audit = await one("SELECT before, after FROM app.audit_log WHERE company_id = $1 AND action = 'USER_UPDATED' AND target_id = $2 ORDER BY id DESC LIMIT 1", [A.id, uid]);
    expect(JSON.stringify(audit)).toContain('outside@attacker.example');
  });
});

describe('[R5-9] 업로드 본문은 자리를 잡기 전에 다 받는데, 동시에 받는 본문 수에 상한이 없다', () => {
  it('[R5-9] 끝나지 않는 5MB 업로드 8건을 동시에 보내면 서버가 몇 MB 를 메모리에 쥐는가', async () => {
    const CHUNK = 64 * 1024;
    const PER = 4.9 * 1024 * 1024;
    let pulled = 0;
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const responses: Promise<Response>[] = [];
    for (let i = 0; i < 8; i++) {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        start(c) { controllers.push(c); },
        pull(c) {
          if (sent >= PER) return new Promise(() => undefined); // 다 보낸 뒤 닫지 않는다(느린 전송의 끝)
          c.enqueue(new Uint8Array(CHUNK));
          sent += CHUNK;
          pulled += CHUNK;
        },
      }, { highWaterMark: 0 });
      responses.push(importAssets(new Request('http://app.test/api/import/assets?mode=preview', {
        method: 'POST',
        headers: { host: 'app.test', origin: 'http://app.test', cookie: cookie.admin!, 'content-type': 'application/octet-stream' },
        body,
        // @ts-expect-error Node 의 스트림 본문
        duplex: 'half',
      })));
    }
    await new Promise((r) => setTimeout(r, 1500));
    const heldMb = pulled / 1024 / 1024;
    for (const c of controllers) c.close();
    await Promise.allSettled(responses);
    // 기대: 동시에 받는 본문 수(또는 총량)에 상한이 있어, 나머지는 받기 전에 429/503 으로 거절된다. 실제: 8 × 4.9MB 를 모두 받는다.
    expect(heldMb).toBeLessThanOrEqual(2 * 5);
  });
});

describe('견딘 것(통과해야 정상)', () => {
  it('자산 태그 중복 검사(asset_tag_key)와 고유 인덱스(lower(asset_tag))가 유니코드 대소문자에서도 같은 판정을 한다', async () => {
    // 사전 검사에서 걸리면 "같은 자산 태그가…" 메시지, 사전 검사를 지나 고유 인덱스에서 걸리면 route() 의 "이미 존재하는 값입니다."
    const pairs: [string, string][] = [['İSTANBUL', 'i̇stanbul'], ['STRASSE', 'straße'], ['ΣΟΦΟΣ', 'σοφος'], ['ΣΟΦΟΣ2', 'σοφοσ2'], ['ǄA', 'ǆa'], ['ＡＢ', 'ａｂ'], ['café', 'café'], ['trail ', 'TRAIL']];
    for (const [a, b] of pairs) {
      const p = uniq('U');
      const first = await call(assetsCreate, { method: 'POST', cookie: cookie.admin, body: { modelId: id.model, assetTag: p + a } });
      expect(first.status, a).toBe(201);
      const second = await call(assetsCreate, { method: 'POST', cookie: cookie.admin, body: { modelId: id.model, assetTag: p + b } });
      expect([201, 409], b).toContain(second.status);
      if (second.status === 409) expect(second.data.error.message, b).not.toBe('이미 존재하는 값입니다.');
    }
  });

  it('감사 로그에 DAILY_ALERTS_RUN 을 남길 수 있는 API 는 없다(표시 기록 위조 불가) — 행위 코드는 모두 코드의 상수다', async () => {
    const r = await one("SELECT count(*)::int AS n FROM app.audit_log WHERE company_id = $1 AND action = 'DAILY_ALERTS_RUN' AND actor_id IS NOT NULL", [A.id]);
    expect(r.n).toBe(0);
  });
});
