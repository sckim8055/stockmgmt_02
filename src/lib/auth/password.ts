import { randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 의 기본 알고리즘은 Argon2id 다. 비용 값은 OWASP 권장 최소치 이상으로 둔다.
const ARGON_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// 없는 계정으로 로그인할 때도 같은 시간이 걸리게 하려고 쓰는 가짜 해시.
let dummyHash: Promise<string> | undefined;
export async function burnVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
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
