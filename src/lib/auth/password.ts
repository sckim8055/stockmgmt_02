import { randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { env } from '@/lib/env';

// @node-rs/argon2 의 기본 알고리즘은 Argon2id 다. 비용 값은 OWASP 권장 최소치 이상으로 둔다.
const ARGON_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** 해시 계산 대기열이 가득 찼다. 호출자는 "잠시 후 다시 시도"로 응답한다. */
export class BusyError extends Error {
  constructor() {
    super('비밀번호 처리 대기열이 가득 찼습니다.');
  }
}

// argon2 는 일부러 무겁다. 로그인 요청이 몰려도 서버가 멈추지 않도록 동시에 계산하는 수를 제한하고,
// 대기열이 길어지면 더 받지 않는다. (프로세스 단위 제한이다)
const MAX_WAITING = 64;
let active = 0;
const waiting: Array<() => void> = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= env.hashConcurrency) {
    if (waiting.length >= MAX_WAITING) throw new BusyError();
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

export function hashPassword(password: string): Promise<string> {
  return limited(() => hash(password, ARGON_OPTIONS));
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return limited(async () => {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false; // 해시 형식이 깨진 경우
    }
  });
}

// 없는 계정으로 로그인할 때도 같은 시간이 걸리게 하려고 쓰는 가짜 해시.
let dummyHash: Promise<string> | undefined;
export async function burnVerify(password: string): Promise<void> {
  dummyHash ??= hash(randomBytes(16).toString('hex'), ARGON_OPTIONS);
  await verifyPassword(await dummyHash, password);
}

/** 비밀번호 규칙 위반 사유. 통과하면 null. */
export function passwordPolicyError(password: string, loginId: string): string | null {
  if (password.length < PASSWORD_MIN) return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`;
  if (password.length > PASSWORD_MAX) return `비밀번호는 ${PASSWORD_MAX}자 이하여야 합니다.`;
  if (password.toLowerCase().includes(loginId.toLowerCase())) return '비밀번호에 로그인 ID를 넣을 수 없습니다.';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (kinds < 3) return '영문 대문자, 소문자, 숫자, 기호 중 3가지 이상을 섞어야 합니다.';
  return null;
}

// 헷갈리는 글자(0/O, 1/l/I)를 뺀 문자표
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export const TEMP_PASSWORD_TTL_HOURS = 72;

/** 관리자가 한 번만 보게 되는 임시 비밀번호. 첫 로그인 때 반드시 바꿔야 한다. */
export function generateTempPassword(): string {
  let out = '';
  for (let i = 0; i < 14; i += 1) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10)}`;
}
