// 자산 목록(/api/assets)과 대시보드(/api/dashboard)가 함께 받는 "정확히 같은 값" 조건의 주소 매개변수.
// 형식은 AssetExactFilter(assets.ts) 설명과 같다. 여기서는 모양만 검사한다(사용자 지정 필드 키가 이 기업의 정의에 있는지,
// 읽을 수 있는지는 prepareAssetFilter 가 본다: 없으면 400, 제한 필드면 403).
import { z } from 'zod';
import { isoDate, str } from '@/lib/validation';
import { badRequest } from '@/lib/http/errors';
import type { AssetExactFilter } from './assets';

export const EXACT_PREFIX = 'eq_';
/** 이 이름의 매개변수는 parseExactParams 가 맡는다(호출하는 쪽의 일반 매개변수 검사에서 뺀다). */
export const EXACT_PLAIN_KEYS = ['blank', 'hasHolder', 'purchaseFrom', 'purchaseTo', 'noPurchaseDate', 'warrantyFrom', 'warrantyTo', 'noWarrantyEnd'] as const;

const CF_NAME = /^cf\.([a-z][a-z0-9_]{0,39})$/;
// 저장된 값과 글자 하나까지 같아야 하므로 앞뒤 공백을 자르지 않는다. 위치는 줄바꿈을 받는 자유 입력이라 줄바꿈도 받는다(NUL 만 거부).
// 길이 상한은 저장할 수 있는 가장 긴 값(사용자 지정 글 필드 500자)과 같다.
const ExactValue = str().min(1).max(500);
const date = isoDate();
const bool = z.enum(['true', 'false']);
/** 한 요청에서 받는 정확히 같은 값 조건 수 상한(사용자 지정 필드 조건 수는 prepareAssetFilter 가 따로 센다) */
const MAX_EXACT = 30;

export const isExactKey = (key: string): boolean => key.startsWith(EXACT_PREFIX) || (EXACT_PLAIN_KEYS as readonly string[]).includes(key);

/** 정확히 같은 값 조건을 읽는다. 모양이 틀리거나 서로 맞지 않는 조건(같은 필드에 값과 "없음")은 400. */
export function parseExactParams(params: URLSearchParams): AssetExactFilter {
  const out: AssetExactFilter = {};
  const custom: Record<string, string> = {};
  const seen = new Set<string>();
  let n = 0;
  const bad = () => badRequest('정확히 같은 값 조건이 올바르지 않습니다.');
  for (const [key, value] of params) {
    if (!isExactKey(key)) continue;
    if (seen.has(key) || ++n > MAX_EXACT) throw bad();
    seen.add(key);
    if (key.startsWith(EXACT_PREFIX)) {
      const name = key.slice(EXACT_PREFIX.length);
      const v = ExactValue.safeParse(value);
      if (!v.success) throw bad();
      if (name === 'manufacturer') out.manufacturer = v.data;
      else if (name === 'location') out.location = v.data;
      else {
        const m = CF_NAME.exec(name);
        if (!m) throw bad();
        custom[m[1]!] = v.data;
      }
      continue;
    }
    if (key === 'blank') {
      const names = value.split(',');
      if (names.length > 21) throw bad();
      const keys: string[] = [];
      for (const name of names) {
        if (name === 'location') {
          if (out.locationBlank) throw bad();
          out.locationBlank = true;
          continue;
        }
        const m = CF_NAME.exec(name);
        if (!m || keys.includes(m[1]!)) throw bad();
        keys.push(m[1]!);
      }
      if (keys.length) out.customBlank = keys;
      continue;
    }
    if (key === 'hasHolder') {
      const v = bool.safeParse(value);
      if (!v.success) throw bad();
      out.hasHolder = v.data === 'true';
      continue;
    }
    if (key === 'noPurchaseDate' || key === 'noWarrantyEnd') {
      if (value !== 'true') throw bad();
      out[key] = true;
      continue;
    }
    const d = date.safeParse(value);
    if (!d.success) throw bad();
    out[key as 'purchaseFrom' | 'purchaseTo' | 'warrantyFrom' | 'warrantyTo'] = d.data;
  }
  if (Object.keys(custom).length) out.custom = custom;
  // 같은 필드에 "이 값"과 "값 없음"을 함께 걸거나, 범위가 뒤집혔거나, 날짜 범위와 "날짜 없음"을 함께 걸면 결과가 늘 비므로 잘못된 요청으로 본다.
  if (out.location !== undefined && out.locationBlank) throw bad();
  if (out.customBlank?.some((k) => Object.hasOwn(custom, k))) throw bad();
  if (out.purchaseFrom && out.purchaseTo && out.purchaseFrom > out.purchaseTo) throw bad();
  if (out.warrantyFrom && out.warrantyTo && out.warrantyFrom > out.warrantyTo) throw bad();
  if (out.noPurchaseDate && (out.purchaseFrom || out.purchaseTo)) throw bad();
  if (out.noWarrantyEnd && (out.warrantyFrom || out.warrantyTo)) throw bad();
  return out;
}
