'use client';
// 숫자·날짜 표시. 현재 언어의 Intl 로캘을 쓴다.
import { useMemo } from 'react';
import { useLang, type Lang } from './index';

export const LOCALE: Record<Lang, string> = { ko: 'ko-KR', en: 'en-US', zh: 'zh-CN' };

export interface Fmt {
  lang: Lang;
  locale: string;
  /** 1,234 */
  num: (n: number) => string;
  /** 소수점 둘째 자리까지 */
  decimal: (n: number) => string;
  /** 부호를 붙인 수량(+3, -2) */
  signed: (n: number) => string;
  /** 날짜와 시각(타임스탬프) */
  dateTime: (iso: string) => string;
  /** 날짜만(타임스탬프) */
  date: (iso: string) => string;
  /** 금액 등 값이 없을 수 있는 숫자 */
  optNum: (v: number | null | undefined) => string;
}

export function makeFmt(lang: Lang): Fmt {
  const locale = LOCALE[lang];
  const num = (n: number) => n.toLocaleString(locale);
  return {
    lang,
    locale,
    num,
    decimal: (n) => n.toLocaleString(locale, { maximumFractionDigits: 2 }),
    signed: (n) => (n > 0 ? `+${num(n)}` : num(n)),
    dateTime: (iso) => new Date(iso).toLocaleString(locale),
    date: (iso) => new Date(iso).toLocaleDateString(locale),
    optNum: (v) => (v === null || v === undefined ? '' : num(v)),
  };
}

export function useFmt(): Fmt {
  const lang = useLang();
  return useMemo(() => makeFmt(lang), [lang]);
}

/** 사전(*.text.ts) 안의 함수 문구가 숫자를 넣을 때 쓴다. 언어마다 자기 로캘로 쓴다. */
export const NUM: Record<Lang, (n: number) => string> = {
  ko: (n) => n.toLocaleString(LOCALE.ko),
  en: (n) => n.toLocaleString(LOCALE.en),
  zh: (n) => n.toLocaleString(LOCALE.zh),
};
export const SIGNED: Record<Lang, (n: number) => string> = {
  ko: (n) => (n > 0 ? '+' : '') + NUM.ko(n),
  en: (n) => (n > 0 ? '+' : '') + NUM.en(n),
  zh: (n) => (n > 0 ? '+' : '') + NUM.zh(n),
};
