'use client';
/**
 * 화면 문구의 다국어(ko / en / zh). 외부 라이브러리 없이 이 파일 하나가 전부다.
 *
 * 설계
 *  - 문구는 그 문구를 쓰는 파일 옆의 `*.text.ts` 에 둔다(예: page.tsx → page.text.ts).
 *    한글은 `*.text.ts` 안에만 있고, 화면 코드(.tsx)에는 문구가 없다.
 *  - 사전은 `dict({ ko, en, zh })` 로 만든다. 모양(키·중첩·함수의 인자 형식)은 ko 에서 추론하고,
 *    en·zh 는 NoInfer 로 그 모양에 맞는지만 검사한다. 키가 빠지거나 남거나, 함수 문구의 인자가 다르면
 *    `tsc` 가 실패한다(= `npm run check` 실패). 숫자·날짜를 문장에 넣는 함수 문구는 언어마다 자기 로캘로 쓴다.
 *  - 화면에서는 `const T = useT(TEXT)` 로 현재 언어의 사전을 받는다. 컴포넌트 밖의 순수 함수에는
 *    사전(또는 `useLang()` 의 값)을 인자로 넘긴다.
 *  - 날짜·숫자 표시는 `useFmt()` (format.ts) 가 현재 언어의 Intl 로캘로 만든다.
 *
 * 언어를 정하는 순서
 *  1. 이 브라우저에서 사용자가 고른 언어(localStorage, 쓸 수 없으면 이 탭의 메모리)
 *  2. 로그인한 사용자의 언어(/api/me 의 lang) — AppShell 이 adoptUserLang() 으로 알려 준다
 *  3. 한국어
 *  고른 언어는 서버에 저장하지 않는다(자기 언어를 바꾸는 API 가 없다). `<html lang>` 은 현재 언어로 맞춘다.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'ko' | 'en' | 'zh';
export const LANGS: readonly Lang[] = ['ko', 'en', 'zh'];
export const DEFAULT_LANG: Lang = 'ko';

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);

/** 세 언어의 사전. en·zh 는 ko 와 같은 모양이어야 한다(컴파일할 때 검사한다). */
export function dict<D>(d: { ko: D; en: NoInfer<D>; zh: NoInfer<D> }): Record<Lang, D> {
  return d;
}

// 컴포넌트 밖의 코드(api() 의 기본 오류 문구 등)가 읽는 현재 언어. LangProvider 가 맞춘다.
let activeLang: Lang = DEFAULT_LANG;
export const getActiveLang = (): Lang => activeLang;

const STORAGE_KEY = 'stockmgmt.lang';
// localStorage 를 쓸 수 없을 때(사생활 보호 모드 등) 이 탭 안에서만 기억한다.
let memoryChoice: Lang | null = null;

function readChoice(): Lang | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (isLang(v)) return v;
  } catch {
    /* 저장소를 쓸 수 없음 → 메모리 값 */
  }
  return memoryChoice;
}

function writeChoice(lang: Lang): void {
  memoryChoice = lang;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* 저장소를 쓸 수 없음 → 메모리에만 남는다 */
  }
}

interface LangValue {
  lang: Lang;
  /** 사용자가 고른 언어. 이 브라우저에 기억한다. */
  chooseLang: (lang: Lang) => void;
  /** 로그인 사용자의 기본 언어. 브라우저에 고른 언어가 없을 때만 따른다. */
  adoptUserLang: (lang: string) => void;
}

const LangContext = createContext<LangValue | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  // 서버 렌더링과 첫 화면은 한국어로 그리고, 브라우저에서 고른 언어를 읽은 뒤 바꾼다(하이드레이션 불일치 방지).
  const [lang, setLang] = useState<Lang>(DEFAULT_LANG);

  useEffect(() => {
    const stored = readChoice();
    if (stored) setLang(stored);
  }, []);

  activeLang = lang;
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const chooseLang = useCallback((next: Lang) => {
    writeChoice(next);
    setLang(next);
  }, []);

  const adoptUserLang = useCallback((userLang: string) => {
    if (readChoice() === null && isLang(userLang)) setLang(userLang);
  }, []);

  const value = useMemo(() => ({ lang, chooseLang, adoptUserLang }), [lang, chooseLang, adoptUserLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

const FALLBACK: LangValue = { lang: DEFAULT_LANG, chooseLang: () => {}, adoptUserLang: () => {} };

export function useLangControl(): LangValue {
  return useContext(LangContext) ?? FALLBACK;
}

export function useLang(): Lang {
  return useLangControl().lang;
}

/** 현재 언어의 사전 */
export function useT<D>(d: Record<Lang, D>): D {
  return d[useLang()];
}
