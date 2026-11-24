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
  it('모든 API 라우트는 route() 로만 만든다', () => {
    const routes = src.filter((f) => /src[\\/]app[\\/]api[\\/].*route\.ts$/.test(f));
    expect(routes.length).toBeGreaterThan(0);
    for (const f of routes) {
      const text = readFileSync(f, 'utf8');
      const exports = [...text.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b([^\n]*)/g)];
      expect(exports.length, `${rel(f)}: 내보낸 핸들러가 없음`).toBeGreaterThan(0);
      for (const m of exports) {
        expect(m[0], `${rel(f)}: ${m[1]} 는 route() 로 만들어야 함`).toMatch(/export const \w+ = route\(/);
      }
    }
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

  it('SQL 문자열에 값을 직접 끼워 넣지 않는다(템플릿 문자열 보간 금지)', () => {
    const offenders: string[] = [];
    for (const f of src) {
      const text = readFileSync(f, 'utf8');
      // .query(`... ${x} ...`) 형태를 찾는다.
      for (const m of text.matchAll(/\.query(?:<[^>]*>)?\(\s*`([^`]*)`/g)) {
        if (m[1]!.includes('${')) offenders.push(rel(f));
      }
    }
    expect(offenders).toEqual([]);
  });
});
