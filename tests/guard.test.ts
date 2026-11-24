// 구조 규칙을 코드로 강제한다. 누가(어느 모델이) 코드를 추가하든 규칙을 어기면 여기서 실패한다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const rel = (f: string) => path.relative(ROOT, f).replaceAll('\\', '/');
const src = walk(path.join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f));

// withSystem(모든 기업이 보이는 문맥)을 쓸 수 있는 파일. 늘릴 때는 반드시 검토를 거친다.
const WITH_SYSTEM_ALLOWED = [
  'src/lib/db/context.ts',
  'src/lib/auth/session.ts',
  'src/lib/auth/login.ts',
  'src/lib/company/create.ts',
  'src/app/api/system/companies/route.ts',
];

// 로그인 없이 호출할 수 있는 API. 늘릴 때는 반드시 검토를 거친다.
const PUBLIC_ROUTES = ['src/app/api/auth/login/route.ts'];

describe('구조 규칙', () => {
  it('모든 API 라우트는 route() 로만 만든다 (다른 형태의 export 는 허용하지 않는다)', () => {
    const routes = src.filter((f) => /src[\\/]app[\\/].*route\.tsx?$/.test(f));
    expect(routes.length).toBeGreaterThan(0);
    for (const f of routes) {
      expect(rel(f).startsWith('src/app/api/'), `${rel(f)}: 라우트 핸들러는 src/app/api 아래에만 둔다`).toBe(true);
      const text = readFileSync(f, 'utf8');
      // export 로 시작하는 모든 문장을 본다. `export { h as GET }`, `export default`, `export *`,
      // `export function GET` 같은 우회 형태를 모두 막는다.
      const exportLines = text.split('\n').filter((line) => /^\s*export\b/.test(line));
      expect(exportLines.length, `${rel(f)}: 내보낸 핸들러가 없음`).toBeGreaterThan(0);
      for (const line of exportLines) {
        expect(line, `${rel(f)}: 허용되지 않은 export`).toMatch(/^export const (GET|POST|PUT|PATCH|DELETE) = route\(/);
      }
      // route( 의 첫 인자는 그 자리에서 쓴 객체이거나, 같은 파일에 정의한 상수여야 한다.
      for (const m of text.matchAll(/=\s*route\(\s*([^\s,]+)/g)) {
        const arg = m[1]!;
        if (arg.startsWith('{')) continue;
        expect(new RegExp(`const ${arg} = \\{`).test(text), `${rel(f)}: route(${arg}) 의 접근 조건을 같은 파일에서 확인할 수 없음`).toBe(true);
      }
      // access 값은 문자열로 직접 적는다(변수로 돌려 쓰지 않는다).
      for (const m of text.matchAll(/\baccess\s*:\s*([^,}\n]+)/g)) {
        expect(m[1]!.trim(), `${rel(f)}: access 는 문자열로 직접 적는다`).toMatch(/^['"](public|self|type|permission)['"]$/);
      }
    }
  });

  it("Server Action('use server')은 쓰지 않는다 (route() 를 거치지 않는 서버 진입점이 된다)", () => {
    const users = src.filter((f) => /['"]use server['"]/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(users).toEqual([]);
  });

  it('DB 문맥(app.company_id, app.system, 역할)을 context.ts 밖에서 바꾸지 않는다', () => {
    const users = src
      .filter((f) => /set_config\s*\(|\bSET\s+(LOCAL\s+|SESSION\s+)?(ROLE|app\.)|RESET\s+(ROLE|ALL)/i.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => f !== 'src/lib/db/context.ts');
    expect(users).toEqual([]);
  });

  it("access: 'public' 은 허용 목록에 있는 라우트에서만 쓴다", () => {
    const users = src.filter((f) => /access:\s*['"]public['"]/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(users.filter((f) => f !== 'src/lib/http/route.ts').sort()).toEqual(PUBLIC_ROUTES.sort());
  });

  it('withSystem 은 허용 목록에 있는 파일에서만 쓴다', () => {
    const users = src.filter((f) => /\bwithSystem\b/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(users.sort()).toEqual([...WITH_SYSTEM_ALLOWED].sort());
  });

  it('DB 풀은 context.ts 밖에서 직접 쓰지 않는다', () => {
    const users = src
      .filter((f) => /\bgetPool\b/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !['src/lib/db/pool.ts', 'src/lib/db/context.ts'].includes(f));
    expect(users).toEqual([]);
  });

  it('pg 모듈은 src/lib/db 밖에서 import 하지 않는다', () => {
    const users = src
      .filter((f) => /from\s+['"]pg['"]/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !f.startsWith('src/lib/db/'));
    expect(users).toEqual([]);
  });

  it('process.env 는 env.ts 와 pool.ts 에서만 읽는다', () => {
    const users = src
      .filter((f) => /process\.env/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !['src/lib/env.ts', 'src/lib/db/pool.ts'].includes(f));
    expect(users).toEqual([]);
  });

  it('화면에서 dangerouslySetInnerHTML 과 innerHTML 을 쓰지 않는다', () => {
    const users = src.filter((f) => /dangerouslySetInnerHTML|\.innerHTML\b/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(users).toEqual([]);
  });

  it('SQL 문자열에 값을 직접 끼워 넣지 않는다', () => {
    // 한계: 정규식 검사라서 모든 경우를 잡지는 못한다. 흔한 실수 형태를 막는 용도다.
    const offenders: string[] = [];
    for (const f of src) {
      if (rel(f) === 'src/lib/db/context.ts') continue; // 쿼리를 그대로 전달하는 래퍼 자체
      const text = readFileSync(f, 'utf8');
      // 1) .query(`... ${x} ...`) : 템플릿 문자열 보간
      for (const m of text.matchAll(/\.query(?:<[^>]*>)?\(\s*`([^`]*)`/g)) {
        if (m[1]!.includes('${')) offenders.push(`${rel(f)}: 템플릿 보간`);
      }
      // 2) .query(변수) : 문자열을 다른 곳에서 조립해 넘기는 형태. SQL_ 로 시작하는 모듈 상수만 허용한다.
      for (const m of text.matchAll(/\.query(?:<[^>]*>)?\(\s*([A-Za-z_$][\w$.]*)/g)) {
        const arg = m[1]!;
        if (/^SQL_[A-Z0-9_]+$/.test(arg)) continue;
        if (/^(lock)$/.test(arg) && /lock \? SQL_[A-Z0-9_]+ : SQL_[A-Z0-9_]+/.test(text)) continue;
        offenders.push(`${rel(f)}: .query(${arg})`);
      }
      // 3) SQL_ 상수는 문자열 리터럴과 다른 상수의 연결로만 만든다(템플릿 보간·함수 호출 금지).
      for (const m of text.matchAll(/const (SQL_[A-Z0-9_]+|ACCOUNT_COLUMNS)\s*=([^;]*);/g)) {
        if (m[2]!.includes('${') || /\w\(/.test(m[2]!.replace(/'[^']*'|`[^`]*`/g, ''))) offenders.push(`${rel(f)}: ${m[1]} 정의`);
      }
      // 4) 문자열 연결로 .query('...' + x) 하는 형태
      if (/\.query(?:<[^>]*>)?\(\s*(['"])(?:(?!\1).)*\1\s*\+/.test(text)) offenders.push(`${rel(f)}: 문자열 연결`);
    }
    expect(offenders).toEqual([]);
  });
});
