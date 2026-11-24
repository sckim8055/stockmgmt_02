// 요청 검증에 함께 쓰는 zod 조각. API 라우트의 문자열·날짜는 여기 것을 쓴다.
import { z } from 'zod';

/**
 * 문자열. NUL 문자(\u0000)를 거부한다. PostgreSQL 의 text·jsonb 는 NUL 을 저장하지 못해,
 * 걸러내지 않으면 쿼리 오류(500)가 된다. z.string() 대신 쓰고 뒤에 .trim().max() 등을 잇는다.
 */
export const str = () => z.string().refine((v) => !v.includes('\u0000'), '사용할 수 없는 문자가 들어 있습니다.');

/** 달력에 실제로 있는 날짜(YYYY-MM-DD). 연도는 1900~2200 만 받는다. */
export const isoDate = () =>
  z.iso.date('YYYY-MM-DD 형식의 실제 날짜여야 합니다.').refine((v) => {
    const year = Number(v.slice(0, 4));
    return year >= 1900 && year <= 2200;
  }, '날짜의 연도가 범위를 벗어났습니다.');

export const isIsoDate = (v: unknown): v is string => typeof v === 'string' && isoDate().safeParse(v).success;
export const hasNul = (v: string): boolean => v.includes('\u0000');
