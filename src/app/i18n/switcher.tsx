'use client';
// 화면 언어 고르기. 고른 값은 이 브라우저에 기억한다.
// 로그인한 화면(상단 바)은 onChosen 으로 계정에도 저장한다. 로그인 전 화면은 onChosen 을 주지 않는다.
import { useId, type CSSProperties } from 'react';
import { LANGS, isLang, useLangControl, useT, type Lang } from './index';
import { LANG_NAME, TEXT } from './langs.text';

export function LangSwitcher({ style, onChosen }: { dark?: boolean; style?: CSSProperties; onChosen?: (lang: Lang) => void }) {
  const T = useT(TEXT);
  const { lang, chooseLang } = useLangControl();
  const id = useId();
  return (
    <span className="lang-switcher" style={style}>
      <label htmlFor={id}>{T.label}</label>
      <select
        id={id}
        data-testid="lang-switcher"
        value={lang}
        title={T.hint}
        onChange={(e) => {
          const next = e.target.value;
          if (!isLang(next)) return;
          chooseLang(next);
          onChosen?.(next);
        }}
      >
        {LANGS.map((l) => (
          <option key={l} value={l} lang={l}>{LANG_NAME[l]}</option>
        ))}
      </select>
    </span>
  );
}
