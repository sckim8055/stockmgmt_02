// 목록 표의 열 너비 저장 값 검사(브라우저 localStorage 에서 읽는 값은 누가 바꿨을지 모른다).
import { describe, expect, it } from 'vitest';
import { clampWidth, COL_MAX, COL_MIN, parseStoredWidths } from '@/app/(app)/column-widths';

describe('column widths: stored value parsing', () => {
  it('reads a valid object of column id → width', () => {
    expect(parseStoredWidths(JSON.stringify({ model: 240, 'cf.remarks': 300, asset_tag: 60, location: 800 }))).toEqual({
      model: 240, 'cf.remarks': 300, asset_tag: 60, location: 800,
    });
  });

  it('ignores anything that is not an object of finite in-range numbers', () => {
    for (const raw of [null, '', 'not json', '[]', '[1,2]', 'null', '42', '"x"', 'true']) expect(parseStoredWidths(raw)).toEqual({});
    expect(
      parseStoredWidths(JSON.stringify({ a: 59, b: 801, c: '200', d: null, e: -5, f: [100], g: { w: 100 }, ok: 61.6 })),
    ).toEqual({ ok: 62 });
    // JSON.parse 로는 Infinity/NaN 이 나오지 않지만 1e400 은 Infinity 가 된다
    expect(parseStoredWidths('{"a": 1e400, "b": 100}')).toEqual({ b: 100 });
  });

  it('ignores keys that are not column ids', () => {
    expect(parseStoredWidths(JSON.stringify({ __proto__x: 100, 'Model': 100, 'cf.': 100, 'cf.Bad': 100, 'x y': 100, ['a'.repeat(41)]: 100, 'cf.good_1': 100 }))).toEqual({ 'cf.good_1': 100 });
    const proto = parseStoredWidths('{"__proto__": {"polluted": 1}, "model": 100}');
    expect(proto).toEqual({ model: 100 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('caps the number of entries', () => {
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`c${i}`, 100]));
    expect(Object.keys(parseStoredWidths(JSON.stringify(many))).length).toBe(100);
  });

  it('clamps widths to the allowed range', () => {
    expect(clampWidth(10)).toBe(COL_MIN);
    expect(clampWidth(5000)).toBe(COL_MAX);
    expect(clampWidth(123.4)).toBe(123);
  });
});
