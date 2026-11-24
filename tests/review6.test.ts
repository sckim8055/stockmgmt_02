// 6단계 독립 검토(review6): 5단계 조치(6c565f7)의 재검토와 결함 재현 테스트.
// 실패하는 테스트가 곧 결함이다. 각 테스트 이름 앞의 [R6-x] 는 검토 보고서의 번호다.
// "견딘 것" describe 는 통과해야 정상인 확인 테스트다(정확성 검증 포함).
//
// 성능 측정은 앱 역할(RLS 적용) + 기업 문맥에서 EXPLAIN (ANALYZE) 로 "읽은 행 수"와 실행 시간을 잰다.
import { appendFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/context';
import { closePool } from '@/lib/db/pool';
import { listStockHistory, type StockHistoryQuery } from '@/lib/reports/history';
import { POST as importAssets } from '@/app/api/import/assets/route';
import { POST as personsCreate } from '@/app/api/master/persons/route';
import { IMPORT_COLUMNS } from '@/lib/import/run';
import { readXlsx, writeXlsx, XLSX_LIMITS } from '@/lib/import/xlsx';
import { strToU8, zipSync } from 'fflate';
import { APP_ROLE, call, closeOwner, makeCompany, owner, sessionFor, type TestCompany } from './helpers';

const one = async (sql: string, params: unknown[] = []) => (await (await owner()).query(sql, params)).rows[0];

/** 소유자 연결로 연 "앱 역할 + 기업 문맥" 트랜잭션 (tests/review5.test.ts 와 같은 방식) */
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
  /** relation 별로 실제로 읽은 행(돌려준 행 + 조건으로 버린 행)과 실행 시간 */
  async function measure(text: string, params: unknown[]): Promise<{ ms: number; read: Record<string, number> }> {
    await c.query('SAVEPOINT x');
    const { rows } = await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params as unknown[]);
    await c.query('ROLLBACK TO SAVEPOINT x');
    const read: Record<string, number> = {};
    const walk = (n: any) => {
      const rel = n['Relation Name'];
      if (rel) {
        const loops = n['Actual Loops'] ?? 1;
        read[rel] = (read[rel] ?? 0) + ((n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0) + (n['Rows Removed by Index Recheck'] ?? 0)) * loops;
      }
      for (const p of n.Plans ?? []) walk(p);
    };
    walk(rows[0]['QUERY PLAN'][0].Plan);
    return { ms: rows[0]['QUERY PLAN'][0]['Execution Time'], read };
  }
  return { db, captured, measure, client: c, end: async () => { await c.query('ROLLBACK'); await c.end(); } };
}

const actorOf = (companyId: string, userId: string) => ({ companyId, userId, userType: 'COMPANY_ADMIN' as const, isAdmin: true, auditIp: null });
const accessOf = (scope: string[] | null) => ({ scope, unrestricted: scope === null, inScope: () => true }) as never;

// 5단계 이전(4b9fd2b)의 재고 이력 쿼리: 전체를 합쳐 정렬한다. 결과 순서·내용의 기준(오라클)으로만 쓴다.
const SQL_ORACLE =
  'SELECT x.* FROM (' +
  '  SELECT $12::text AS kind, t.id, t.seq, t.created_at, t.type, a.id AS ref_id, a.asset_tag AS ref_label, m.manufacturer, m.name AS model_name, d.name AS department_name,' +
  '    NULL::int AS qty, fp.name AS from_person, tp.name AS to_person, t.from_state, t.to_state, t.to_location AS location, t.note, u.display_name AS actor_name' +
  '    FROM app.asset_txn t' +
  '    JOIN app.asset a ON a.id = t.asset_id AND a.company_id = t.company_id' +
  '    JOIN app.item_model m ON m.id = a.model_id AND m.company_id = t.company_id' +
  '    JOIN app.department d ON d.id = a.department_id AND d.company_id = t.company_id' +
  '    LEFT JOIN app.person fp ON fp.id = t.from_holder_id AND fp.company_id = t.company_id' +
  '    LEFT JOIN app.person tp ON tp.id = t.to_holder_id AND tp.company_id = t.company_id' +
  '    LEFT JOIN app.app_user u ON u.id = t.actor_id' +
  '   WHERE t.company_id = $1 AND ($2::uuid[] IS NULL OR a.department_id = ANY($2))' +
  '     AND ($9::text IS NULL OR $9 = $12) AND ($3::text IS NULL OR t.type = $3)' +
  '     AND ($4::uuid IS NULL OR t.from_holder_id = $4 OR t.to_holder_id = $4)' +
  '     AND ($5::text IS NULL OR a.asset_tag ILIKE $5 OR m.name ILIKE $5 OR m.manufacturer ILIKE $5)' +
  '     AND ($6::date IS NULL OR t.created_at >= ($6::date::timestamp AT TIME ZONE $8))' +
  '     AND ($7::date IS NULL OR t.created_at < (($7::date + 1)::timestamp AT TIME ZONE $8))' +
  '  UNION ALL' +
  '  SELECT $13::text, t.id, t.seq, t.created_at, t.type, s.id, NULL, m.manufacturer, m.name, d.name,' +
  '    t.qty, NULL, p.name, NULL, NULL, t.location_note, t.note, u.display_name' +
  '    FROM app.peripheral_txn t' +
  '    JOIN app.peripheral_stock s ON s.id = t.stock_id AND s.company_id = t.company_id' +
  '    JOIN app.item_model m ON m.id = s.model_id AND m.company_id = t.company_id' +
  '    JOIN app.department d ON d.id = s.department_id AND d.company_id = t.company_id' +
  '    LEFT JOIN app.person p ON p.id = t.person_id AND p.company_id = t.company_id' +
  '    LEFT JOIN app.app_user u ON u.id = t.actor_id' +
  '   WHERE t.company_id = $1 AND ($2::uuid[] IS NULL OR s.department_id = ANY($2))' +
  '     AND ($9::text IS NULL OR $9 = $13) AND ($3::text IS NULL OR t.type = $3)' +
  '     AND ($4::uuid IS NULL OR t.person_id = $4)' +
  '     AND ($5::text IS NULL OR m.name ILIKE $5 OR m.manufacturer ILIKE $5)' +
  '     AND ($6::date IS NULL OR t.created_at >= ($6::date::timestamp AT TIME ZONE $8))' +
  '     AND ($7::date IS NULL OR t.created_at < (($7::date + 1)::timestamp AT TIME ZONE $8))' +
  ') x WHERE $10::int = $11::int ORDER BY x.created_at DESC, x.kind, x.seq DESC';
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

afterAll(async () => {
  await closeOwner();
  await closePool();
});

// ─────────────────────────── 재고 이력: 쪽 나눔의 정확성 ───────────────────────────

describe('견딘 것: 재고 이력 쪽 나눔 — 두 이력이 같은 시각에 섞여 있어도 모든 쪽이 빠짐·겹침 없이 바른 순서다', () => {
  let C: TestCompany;
  const d: Record<string, any> = {};
  const persons: any[] = [];

  beforeAll(async () => {
    C = await makeCompany('R6H');
    const o = await owner();
    d.it = (await one('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [C.id])).id;
    d.d2 = (await one("INSERT INTO app.department (company_id, name) VALUES ($1, 'R6 Sales') RETURNING id", [C.id])).id;
    const catA = (await one("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'R6 Laptop') RETURNING id", [C.id])).id;
    const catP = (await one("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'R6 Mouse') RETURNING id", [C.id])).id;
    const mA1 = (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Acme', 'Laptop 100%') RETURNING id", [C.id, catA])).id;
    const mA2 = (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Zeta', 'Phone_X') RETURNING id", [C.id, catA])).id;
    const mP1 = (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'Acme', 'Mouse') RETURNING id", [C.id, catP])).id;
    const mP2 = (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'Beta', 'Cable') RETURNING id", [C.id, catP])).id;
    for (let i = 0; i < 3; i++) persons.push((await one('INSERT INTO app.person (company_id, name) VALUES ($1, $2) RETURNING id', [C.id, `R6P${i}`])).id);
    const assets: string[] = [];
    const specs: [string, string, string][] = [['A%1', mA1, d.it], ['A_2', mA2, d.it], ['B-3', mA1, d.d2], ['B-4', mA2, d.d2], ['C-5', mA1, d.it], ['c-6', mA2, d.d2]];
    for (const [tag, model, dept] of specs) {
      assets.push((await one("INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate, department_id) VALUES ($1, $2, $3, 'IN_STOCK', 'AVAILABLE', $4) RETURNING id", [C.id, model, tag, dept])).id);
    }
    const stocks: string[] = [];
    for (const [model, dept] of [[mP1, d.it], [mP1, d.d2], [mP2, d.it], [mP2, d.d2]] as const) {
      stocks.push((await one('INSERT INTO app.peripheral_stock (company_id, model_id, department_id, on_hand_qty) VALUES ($1, $2, $3, 100) RETURNING id', [C.id, model, dept])).id);
    }
    // 시각은 8개뿐(같은 시각이 많다). 서울 기준 날짜 경계(15:00 UTC)를 걸치게 고른다.
    const times = ['2026-03-01T14:59:59Z', '2026-03-01T15:00:00Z', '2026-03-02T00:00:00Z', '2026-03-02T14:59:59.999999Z', '2026-03-02T15:00:00Z', '2026-03-05T03:00:00Z', '2026-03-05T03:00:00Z', '2026-03-09T23:00:00Z'];
    const aTypes = ['ASSIGN', 'RETURN', 'LOAN', 'UPDATE', 'DISPOSE'];
    const pTypes = ['RECEIVE', 'ISSUE', 'LOAN', 'RETURN', 'DISPOSE'];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 130; i++) {
      const from = rnd(3) === 0 ? persons[rnd(3)] : null;
      const to = rnd(3) === 0 ? persons[rnd(3)] : null;
      await o.query('INSERT INTO app.asset_txn (company_id, asset_id, type, from_holder_id, to_holder_id, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [C.id, assets[rnd(assets.length)], aTypes[rnd(aTypes.length)], from, to, `a${i}`, times[rnd(times.length)]]);
    }
    for (let i = 0; i < 95; i++) {
      await o.query('INSERT INTO app.peripheral_txn (company_id, stock_id, type, qty, person_id, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [C.id, stocks[rnd(stocks.length)], pTypes[rnd(pTypes.length)], 1 + rnd(5), rnd(2) ? persons[rnd(3)] : null, `p${i}`, times[rnd(times.length)]]);
    }
  });

  it('필터 조합 × 쪽 크기 × 쪽 수 상한(100)까지: 새 쿼리의 쪽을 이어 붙이면 이전(전체 정렬) 쿼리의 결과와 같다', async () => {
    const s = await tenantSession(C.id);
    try {
      const filters: { q: StockHistoryQuery; scope: string[] | null }[] = [];
      const base: StockHistoryQuery[] = [
        {}, { kind: 'ASSET' }, { kind: 'PERIPHERAL' }, { type: 'LOAN' }, { type: 'DISPOSE' }, { type: 'ISSUE' }, { type: 'NOPE' },
        { personId: persons[0] }, { personId: persons[2] }, { q: 'acme' }, { q: '%' }, { q: '_' }, { q: 'phone_x' }, { q: 'b-' }, { q: 'cable' },
        { from: '2026-03-02' }, { to: '2026-03-01' }, { from: '2026-03-02', to: '2026-03-02' }, { from: '2026-03-03', to: '2026-03-08' }, { from: '2026-03-10' },
        { kind: 'ASSET', personId: persons[1], from: '2026-03-02' }, { q: 'acme', type: 'LOAN', to: '2026-03-05' },
      ];
      for (const b of base) for (const scope of [null, [d.it], [d.d2], [], [d.it, d.d2]]) filters.push({ q: b, scope });
      let checked = 0;
      for (const f of filters) {
        const q = f.q.q?.trim();
        const { rows: expected } = await s.client.query(SQL_ORACLE, [
          C.id, f.scope, f.q.type ?? null, f.q.personId ?? null, q ? likePattern(q) : null, f.q.from ?? null, f.q.to ?? null, 'Asia/Seoul', f.q.kind ?? null, 0, 0, 'ASSET', 'PERIPHERAL',
        ]);
        for (const pageSize of [1, 2, 7, 50]) {
          const got: any[] = [];
          for (let page = 1; page <= 100; page++) {
            const r = await listStockHistory(s.db, actorOf(C.id, C.adminUserId), accessOf(f.scope), { ...f.q, page, pageSize });
            const want = expected.slice((page - 1) * pageSize, page * pageSize);
            expect(r.items.map((x: any) => `${x.kind}:${x.id}`), JSON.stringify({ f, pageSize, page })).toEqual(want.map((x: any) => `${x.kind}:${x.id}`));
            expect(r.items, JSON.stringify({ f, pageSize, page })).toEqual(want);
            expect(r.hasMore, JSON.stringify({ f, pageSize, page })).toBe(expected.length > page * pageSize);
            got.push(...r.items);
            checked++;
            if (!r.hasMore) break;
          }
          expect(new Set(got.map((x) => `${x.kind}:${x.id}`)).size).toBe(got.length);
        }
      }
      expect(checked).toBeGreaterThan(2000);
    } finally {
      await s.end();
    }
  }, 600_000);
});

// ─────────────────────────── 재고 이력: 규모에서의 비용 ───────────────────────────

describe('[R6-1] 재고 이력: 드물게 맞는 조건(부서 범위·검색어·직원·종류·과거 기간)은 여전히 기업의 이력 전체를 읽는다', () => {
  let P: TestCompany;
  const d: Record<string, any> = {};
  const results: Record<string, { ms: number; asset_txn: number; peripheral_txn: number; asset: number; rows: number }> = {};

  beforeAll(async () => {
    P = await makeCompany('R6P');
    const o = await owner();
    d.it = (await one('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [P.id])).id;
    d.rare = (await one("INSERT INTO app.department (company_id, name) VALUES ($1, 'R6 Branch') RETURNING id", [P.id])).id;
    const cat = (await one("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', 'R6P Laptop') RETURNING id", [P.id])).id;
    const catP = (await one("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'PERIPHERAL', 'R6P Mouse') RETURNING id", [P.id])).id;
    const m = (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Lenovo', 'T14') RETURNING id", [P.id, cat])).id;
    const mp = (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'PERIPHERAL', 'Logi', 'M100') RETURNING id", [P.id, catP])).id;
    d.stock = (await one('INSERT INTO app.peripheral_stock (company_id, model_id, department_id, on_hand_qty) VALUES ($1, $2, $3, 100) RETURNING id', [P.id, mp, d.it])).id;
    await o.query("INSERT INTO app.person (company_id, employee_no, name) SELECT $1, 'R6PE' || g, 'Person ' || g FROM generate_series(1, 1000) g", [P.id]);
    d.rarePerson = (await one("INSERT INTO app.person (company_id, name) VALUES ($1, 'Rare Person') RETURNING id", [P.id])).id;
    await o.query("INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate, department_id) SELECT $1, $2, 'R6P-' || g, 'IN_STOCK', 'AVAILABLE', $3 FROM generate_series(1, 2000) g", [P.id, m, d.it]);
    await o.query("INSERT INTO app.asset (company_id, model_id, asset_tag, state, substate, department_id) SELECT $1, $2, 'BR-' || g, 'IN_STOCK', 'AVAILABLE', $3 FROM generate_series(1, 3) g", [P.id, m, d.rare]);
    // 이력 200,000건(약 14개월, 2분 간격) + 지점 자산의 오래된 이력 30건 + 드문 직원의 이력 5건
    await o.query(
      `INSERT INTO app.asset_txn (company_id, asset_id, type, to_holder_id, note, created_at)
       SELECT $1, a.id, CASE WHEN g % 50 = 0 THEN 'ASSIGN' ELSE 'UPDATE' END,
              (SELECT p.id FROM app.person p WHERE p.company_id = $1 AND p.employee_no = 'R6PE' || (1 + g % 1000)) , 'n', now() - (g * 2 || ' minutes')::interval
         FROM generate_series(1, 200000) g
         JOIN LATERAL (SELECT id FROM app.asset WHERE company_id = $1 AND asset_tag = 'R6P-' || (1 + g % 2000)) a ON true`,
      [P.id],
    );
    await o.query("INSERT INTO app.asset_txn (company_id, asset_id, type, note, created_at) SELECT $1, a.id, 'UPDATE', 'branch', now() - interval '400 days' - (g || ' hours')::interval FROM app.asset a CROSS JOIN generate_series(1, 10) g WHERE a.company_id = $1 AND a.department_id = $2", [P.id, d.rare]);
    await o.query("INSERT INTO app.asset_txn (company_id, asset_id, type, to_holder_id, note, created_at) SELECT $1, a.id, 'DISPOSE', $3, 'x', now() - interval '410 days' FROM app.asset a WHERE a.company_id = $1 AND a.asset_tag IN ('R6P-1','R6P-2','R6P-3','R6P-4','R6P-5') AND $2::uuid IS NOT NULL", [P.id, d.rare, d.rarePerson]);
    await o.query("INSERT INTO app.peripheral_txn (company_id, stock_id, type, qty, note, created_at) SELECT $1, $2, 'ISSUE', 1, 'n', now() - (g * 8 || ' minutes')::interval FROM generate_series(1, 50000) g", [P.id, d.stock]);
    await o.query('ANALYZE app.asset, app.asset_txn, app.peripheral_txn, app.person, app.peripheral_stock, app.item_model');
  }, 300_000);

  const past = () => new Date(Date.now() - 405 * 86400_000).toISOString().slice(0, 10);
  const cases: [string, () => { q: StockHistoryQuery; scope: () => string[] | null }][] = [
    ['p1 no filter', () => ({ q: {}, scope: () => null })],
    ['p100 no filter (50/page)', () => ({ q: { page: 100 }, scope: () => null })],
    ['p100 no filter (200/page)', () => ({ q: { page: 100, pageSize: 200 }, scope: () => null })],
    ['p1 scope=branch dept (30 rows match)', () => ({ q: {}, scope: () => [d.rare] })],
    ['p100 scope=IT (most rows match)', () => ({ q: { page: 100 }, scope: () => [d.it] })],
    ['p1 q=rare tag "BR-2"', () => ({ q: { q: 'BR-2' }, scope: () => null })],
    ['p1 q=no match "zzzz"', () => ({ q: { q: 'zzzz' }, scope: () => null })],
    ['p1 q=common "T14"', () => ({ q: { q: 'T14' }, scope: () => null })],
    ['p1 person=rare', () => ({ q: { personId: d.rarePerson }, scope: () => null })],
    ['p1 type=DISPOSE (5 rows)', () => ({ q: { type: 'DISPOSE' }, scope: () => null })],
    ['p1 from=to=405 days ago', () => ({ q: { from: past(), to: past() }, scope: () => null })],
    ['p1 to=405 days ago', () => ({ q: { to: past() }, scope: () => null })],
    ['p1 scope=branch + q=zzzz', () => ({ q: { q: 'zzzz' }, scope: () => [d.rare] })],
  ];

  for (const [name, mk] of cases) {
    it(`측정: ${name}`, async () => {
      const { q, scope } = mk();
      const s = await tenantSession(P.id);
      try {
        const r = await listStockHistory(s.db, actorOf(P.id, P.adminUserId), accessOf(scope()), { pageSize: 50, ...q });
        const sql = s.captured.find((x) => x.text.includes('app.asset_txn'))!;
        await s.measure(sql.text, sql.params); // 데우기
        const m = await s.measure(sql.text, sql.params);
        if (m.ms > 1000) {
          const { rows: plan } = await s.client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql.text}`, sql.params as unknown[]);
          appendFileSync('/tmp/review6-slowplan.log', `[R6-1] ${name}\n${plan.map((x: any) => x['QUERY PLAN']).join('\n')}\n`);
        }
        results[name] = { ms: Math.round(m.ms), asset_txn: m.read.asset_txn ?? 0, peripheral_txn: m.read.peripheral_txn ?? 0, asset: m.read.asset ?? 0, rows: r.items.length };
        appendFileSync('/tmp/review6-measure.log', `[R6-1] ${name}: ${JSON.stringify(results[name])}\n`);
      } finally {
        await s.end();
      }
    }, 120_000);
  }

  it('[R6-1] 범위가 지점 하나로 제한된 일반 사용자가 이력 화면을 열면(첫 쪽) asset_txn 을 몇 행 읽는가', () => {
    // 조치: 조건은 "기간 안의 최근 2만 건" 안에서만 찾는다(HISTORY_SCAN_WINDOW). 읽는 양은 이력 크기와 무관하게 그 상한을 넘지 않는다.
    expect(results['p1 scope=branch dept (30 rows match)']!.asset_txn).toBeLessThanOrEqual(20000);
  });
  it('[R6-1] 아무 권한 있는 사용자가 맞는 것이 없는 검색어를 넣으면 asset_txn 을 몇 행 읽는가', () => {
    expect(results['p1 q=no match "zzzz"']!.asset_txn).toBeLessThanOrEqual(20000);
  });
  it('[R6-1b] 범위 제한 사용자의 100쪽: 이름 붙이기(person LEFT JOIN)가 행마다 person 을 순차로 다시 읽는 계획이 될 수 있다', () => {
    // 이 파일 전체를 돌리면(통계가 바뀌어) 주변기기 쪽에서 "Nested Loop Left Join → Seq Scan on person" 이 5,001회 반복된다(약 2.5초).
    // 계획은 /tmp/review6-slowplan.log 에 남긴다. 직원 수에 비례하므로 직원 1만 명 기업이면 statement_timeout(30s)에 닿는다.
    expect(results['p100 scope=IT (most rows match)']!.ms).toBeLessThanOrEqual(500);
  });
  it('[R6-1] 과거 날짜 범위(to=405일 전)는 시각 인덱스의 범위 조건으로 읽기 시작해야 한다', () => {
    expect(results['p1 to=405 days ago']!.asset_txn).toBeLessThanOrEqual(51 * 20);
  });
});

// ─────────────────────────── 역할 실행 제한(set-role-limits.mjs)과 업로드 잠금 ───────────────────────────

const upload = (cookie: string, file: Uint8Array, mode: 'preview' | 'commit') =>
  importAssets(new Request(`http://app.test/api/import/assets?mode=${mode}`, {
    method: 'POST',
    headers: { host: 'app.test', origin: 'http://app.test', cookie, 'content-type': 'application/octet-stream' },
    body: file as BodyInit,
  }));

describe('[R6-2] 2,000행 자산 업로드가 기업 잠금을 잡는 동안 같은 기업의 관리 요청은 기다린다 — lock_timeout 30s 를 넘으면 500', () => {
  let L: TestCompany;
  let cookie: string;
  let file: Uint8Array;
  const timings: Record<string, unknown> = {};

  beforeAll(async () => {
    L = await makeCompany('R6L');
    const o = await owner();
    const it = (await one('SELECT id FROM app.department WHERE company_id = $1 AND is_default', [L.id])).id;
    const cat = (await one("INSERT INTO app.category (company_id, kind, name) VALUES ($1, 'ASSET', '노트북') RETURNING id", [L.id])).id;
    const m = (await one("INSERT INTO app.item_model (company_id, category_id, kind, manufacturer, name) VALUES ($1, $2, 'ASSET', 'Lenovo', 'T14') RETURNING id", [L.id, cat])).id;
    await o.query("INSERT INTO app.asset (company_id, model_id, asset_tag, serial_number, state, substate, department_id) SELECT $1, $2, 'OLD-' || g, 'SN-OLD-' || g, 'IN_STOCK', 'AVAILABLE', $3 FROM generate_series(1, 20000) g", [L.id, m, it]);
    await o.query("INSERT INTO app.person (company_id, employee_no, name) SELECT $1, 'E' || g, 'P' || g FROM generate_series(1, 2000) g", [L.id]);
    await o.query('ANALYZE app.asset, app.person');
    cookie = await sessionFor(L.code, 'admin');
    const header = IMPORT_COLUMNS.assets.map((c) => (c.required ? `${c.header}*` : c.header));
    const rows = Array.from({ length: 2000 }, (_, i) => ['NEW-' + i, '노트북', 'Lenovo', 'T14', 'SN-NEW-' + i, '', '본관', 'E' + (i + 1), '2025-01-01', '', '', '2027-01-01']);
    file = writeXlsx([{ name: '자산', rows: [header, ...rows] }]);
  }, 300_000);

  afterAll(async () => {
    await (await owner()).query(`ALTER ROLE ${APP_ROLE} RESET ALL`);
    await closePool();
    appendFileSync('/tmp/review6-measure.log', `[R6-2] ${JSON.stringify(timings)}\n`);
  });

  it('측정: 업로드(미리보기) 시간과, 그동안 직원 등록 요청이 기다린 시간', async () => {
    const t0 = Date.now();
    const imp = upload(cookie, file, 'preview').then(async (r) => ({ status: r.status, ms: Date.now() - t0, body: await r.json() }));
    await new Promise((r) => setTimeout(r, 500));
    const t1 = Date.now();
    const person = await call(personsCreate, { method: 'POST', cookie, body: { name: 'Waiter' } });
    timings.previewWaiter = { status: person.status, waitedMs: Date.now() - t1 };
    const done = await imp;
    timings.preview = { status: done.status, ms: done.ms, errors: done.body.errors?.length, total: done.body.totalRows };
    expect(done.status).toBe(200);
  }, 300_000);

  it('측정: 업로드(반영) 시간과, 그동안 직원 등록 요청이 기다린 시간', async () => {
    const t0 = Date.now();
    const imp = upload(cookie, file, 'commit').then(async (r) => ({ status: r.status, ms: Date.now() - t0, body: await r.json() }));
    await new Promise((r) => setTimeout(r, 500));
    const t1 = Date.now();
    const person = await call(personsCreate, { method: 'POST', cookie, body: { name: 'Waiter-commit' } });
    timings.commitWaiter = { status: person.status, waitedMs: Date.now() - t1 };
    const done = await imp;
    timings.commit = { status: done.status, ms: done.ms, committed: done.body.committed };
    expect(done.status).toBe(200);
    // 다음 측정(lock_timeout)이 같은 파일을 미리보기로 쓰므로 태그가 겹치지 않게 바꾼다
    const header = IMPORT_COLUMNS.assets.map((c) => (c.required ? `${c.header}*` : c.header));
    file = writeXlsx([{ name: '자산', rows: [header, ...Array.from({ length: 2000 }, (_, i) => ['NEW2-' + i, '노트북', 'Lenovo', 'T14', 'SN-NEW2-' + i, '', '본관', 'E' + (i + 1), '2025-01-01', '', '', '2027-01-01'])] }]);
  }, 300_000);

  it('[R6-5] 업로드 중 같은 기업의 관리 요청 몇 건이 잠금을 기다리며 DB 연결을 모두 잡으면, 다른 기업의 요청이 5초 뒤 500 을 받는다', async () => {
    const Z = await makeCompany('R6Z');
    const cz = await sessionFor(Z.code, 'admin');
    const imp = upload(cookie, file, 'preview');
    await new Promise((r) => setTimeout(r, 500));
    // 풀 크기(DB_POOL_MAX, 테스트 기본 5)보다 많은 대기 요청. 각자 연결을 잡은 채 업로드가 끝나기를 기다린다.
    const waiters = Array.from({ length: 6 }, (_, i) => call(personsCreate, { method: 'POST', cookie, body: { name: `Wait${i}` } }));
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    const other = await call(personsCreate, { method: 'POST', cookie: cz, body: { name: 'Other tenant' } });
    timings.otherTenant = { status: other.status, ms: Date.now() - t0, body: other.data };
    timings.waiters = (await Promise.all(waiters)).map((w) => w.status);
    await imp;
    // 기대: 다른 기업의 요청은 이 기업의 잠금 대기와 무관하게 처리된다. 실제: 연결을 얻지 못해 약 5초 뒤 500.
    expect(other.status).toBe(201);
  }, 300_000);

  it('[R6-2] lock_timeout 이 걸리면 기다리던 요청은 무엇을 받는가 (lock_timeout=1s 로 축소해 재현)', async () => {
    const o = await owner();
    await o.query(`ALTER ROLE ${APP_ROLE} SET lock_timeout = '1s'`);
    await closePool(); // 새 연결부터 역할 설정이 적용된다
    const t0 = Date.now();
    const imp = upload(cookie, file, 'preview').then(async (r) => ({ status: r.status, ms: Date.now() - t0 }));
    await new Promise((r) => setTimeout(r, 500));
    const person = await call(personsCreate, { method: 'POST', cookie, body: { name: 'Waiter2' } });
    timings.lockTimeoutWaiter = { status: person.status, body: person.data };
    timings.lockTimeoutImport = await imp;
    // 기대: 잠금 대기 시간 초과는 "다른 작업이 진행 중이니 잠시 후 다시"(409/503 등)로 알려 준다. 실제: 500 "서버 오류가 발생했습니다."
    expect(person.status).not.toBe(500);
  }, 300_000);
});

// ─────────────────────────── 업로드: 동시 수신 상한(R5-9 조치)과 빈 행(R5-5 조치) ───────────────────────────

describe('[R6-3] 업로드 본문 동시 수신 상한 2건: 한 기업의 사용자가 보내지 않는 업로드 2건으로 모든 기업의 업로드를 막는다', () => {
  it('[R6-3] 기업 X 가 끝나지 않는 업로드 2건을 열어 두면, 기업 Y 의 정상 업로드가 429 를 받는다', async () => {
    const X = await makeCompany('R6X');
    const Y = await makeCompany('R6Y');
    const cx = await sessionFor(X.code, 'admin');
    const cy = await sessionFor(Y.code, 'admin');
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const hanging: Promise<Response>[] = [];
    for (let i = 0; i < 2; i++) {
      // 한 바이트도 보내지 않는다(대역폭이 거의 들지 않는다). 서버는 30초 동안 자리를 잡고 기다린다.
      const body = new ReadableStream<Uint8Array>({ start(c) { controllers.push(c); }, pull() { return new Promise(() => undefined); } }, { highWaterMark: 0 });
      hanging.push(importAssets(new Request('http://app.test/api/import/assets?mode=preview', {
        method: 'POST',
        headers: { host: 'app.test', origin: 'http://app.test', cookie: cx, 'content-type': 'application/octet-stream' },
        body,
        // @ts-expect-error Node 의 스트림 본문
        duplex: 'half',
      })));
    }
    await new Promise((r) => setTimeout(r, 300));
    const header = IMPORT_COLUMNS.assets.map((c) => (c.required ? `${c.header}*` : c.header));
    const victim = await upload(cy, writeXlsx([{ name: '자산', rows: [header] }]), 'preview');
    const victimStatus = victim.status;
    for (const c of controllers) c.close();
    const freed = await Promise.all(hanging);
    const after = await upload(cy, writeXlsx([{ name: '자산', rows: [header] }]), 'preview');
    appendFileSync('/tmp/review6-measure.log', `[R6-3] victim=${victimStatus} attackers=${freed.map((r) => r.status)} after=${after.status}\n`);
    expect(after.status).not.toBe(429); // 상한 계수는 풀린다(견딘 것)
    // 기대: 다른 기업(또는 다른 사용자)의 업로드는 영향을 받지 않는다(사용자·기업 단위 상한). 실제: 429 IMPORT_BUSY
    expect(victimStatus).not.toBe(429);
  });
});

const WB = strToU8('<workbook xmlns:r="r"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>');
const RELS = strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
const sheetZip = (xml: string) => zipSync({ 'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': strToU8(xml) }, { level: 9 });
function fill(head: string, gen: (i: number) => string, tail: string): string {
  const parts = [head];
  let size = head.length + tail.length;
  for (let i = 0; ; i++) {
    const p = gen(i);
    if (!p || size + p.length > XLSX_LIMITS.partBytes - 100) break;
    parts.push(p);
    size += p.length;
  }
  parts.push(tail);
  return parts.join('');
}
const time = (f: () => unknown) => { const t = performance.now(); try { f(); } catch { /* 결과와 무관 */ } return performance.now() - t; };

describe('[R6-4] 빈 행을 세지 않게 바꾼 뒤(R5-5), 빈 행만 16MB 채운 파일이 업로드 처리(동기)를 이전 최대치의 몇 배나 붙잡는다', () => {
  it('[R6-4] 빈 행 약 100만 개(압축 2MB)의 읽기 시간 vs 값이 있는 2,000행으로 16MB 를 채운 파일', () => {
    const empty = sheetZip(fill('<worksheet><sheetData>', (i) => `<row r="${i + 1}"/>`, '</sheetData></worksheet>'));
    const cell = 'x'.repeat(190);
    const full = sheetZip(fill('<worksheet><sheetData>', (i) => (i >= 2000 ? '' : `<row r="${i + 1}">${'<c t="inlineStr"><is><t>' + cell + '</t></is></c>'.repeat(40)}</row>`), '</sheetData></worksheet>'));
    expect(empty.length).toBeLessThan(XLSX_LIMITS.fileBytes);
    // 조치: 빈 행까지 센 행 요소가 2만 개를 넘으면 거기서 멈추고 거부한다.
    const tryRead = (f: Uint8Array) => { try { readXlsx(f); } catch { /* 거부 */ } };
    time(() => readXlsx(full)); time(() => tryRead(empty)); // 데우기
    const tFull = Math.min(time(() => readXlsx(full)), time(() => readXlsx(full)));
    const tEmpty = Math.min(time(() => tryRead(empty)), time(() => tryRead(empty)));
    appendFileSync('/tmp/review6-measure.log', `[R6-4] empty-row flood ${Math.round(tEmpty)}ms (zip ${Math.round(empty.length / 1024)}KB) vs 2000 filled rows ${Math.round(tFull)}ms\n`);
    expect(() => readXlsx(empty)).toThrow(/행이 너무 많습니다/);
    // 16MB 를 푸는 시간은 남는다(읽기 전에 그 부분을 다 푼다). 문서에 적은 최악 시간(약 0.6초)의 범위 안이어야 한다.
    expect(tEmpty).toBeLessThanOrEqual(600);
  });
});

describe('견딘 것: 빈 행을 건너뛰어도 행 번호 한도와 순서 검사는 그대로다', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `<row r="${i + 2}"><c r="B${i + 2}" s="1"/></row>`).join('');
  const head = '<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row>';
  const last = (r: number) => `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>x</t></is></c></row>`;
  it('빈 행 1,999개 뒤 r=2001 의 값은 받고, r=2002 는 거부한다', () => {
    const ok = readXlsx(sheetZip(`<worksheet><sheetData>${head}${rows(1999)}${last(2001)}</sheetData></worksheet>`));
    expect(ok.length).toBe(2001);
    expect(ok[2000]).toEqual(['x']);
    expect(() => readXlsx(sheetZip(`<worksheet><sheetData>${head}${rows(2000)}${last(2002)}</sheetData></worksheet>`))).toThrow(/행이 너무 많습니다/);
  });
  it('빈 행이 순서를 어기면(r 이 줄어들면) 거부한다', () => {
    expect(() => readXlsx(sheetZip(`<worksheet><sheetData>${head}<row r="5"/><row r="3"/>${last(6)}</sheetData></worksheet>`))).toThrow(/순서/);
  });
  it('열 한도 밖에만 칸이 있는 행: 빈 값이면 건너뛰고, 값이 있으면 거부한다', () => {
    expect(readXlsx(sheetZip(`<worksheet><sheetData>${head}<row r="2"><c r="XFD2" s="1"/><c r="AZ2" t="inlineStr"><is><t> </t></is></c></row></sheetData></worksheet>`))).toEqual([['h']]);
    expect(() => readXlsx(sheetZip(`<worksheet><sheetData>${head}<row r="2"><c r="AZ2" t="inlineStr"><is><t>v</t></is></c></row></sheetData></worksheet>`))).toThrow(/열이 너무 많습니다/);
  });
  it('r 없는 빈 행도 행 위치를 차지한다(엑셀과 같은 해석) — 빈 행 2,000개 뒤의 값은 거부', () => {
    expect(() => readXlsx(sheetZip(`<worksheet><sheetData>${head}${'<row/>'.repeat(2000)}<row><c t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>`))).toThrow(/행이 너무 많습니다/);
  });
});
