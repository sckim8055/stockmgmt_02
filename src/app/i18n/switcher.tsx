'use client';
// 화면 언어 고르기. 고른 값은 이 브라우저에만 기억한다(서버에 저장하지 않는다).
import { useId, type CSSProperties } from 'react';
import { LANGS, isLang, useLangControl, useT } from './index';
import { LANG_NAME, TEXT } from './langs.text';

export function LangSwitcher({ dark, style }: { dark?: boolean; style?: CSSProperties }) {
  const T = useT(TEXT);
  const { lang, chooseLang } = useLangControl();
  const id = useId();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, ...style }}>
      <label htmlFor={id} style={{ color: dark ? '#d1d5db' : '#4b5563' }}>{T.label}</label>
      <select
        id={id}
        data-testid="lang-switcher"
        value={lang}
        title={T.hint}
        onChange={(e) => {
          if (isLang(e.target.value)) chooseLang(e.target.value);
        }}
        style={{ padding: '3px 6px', borderRadius: 5, border: dark ? '1px solid #4b5563' : '1px solid #c9ced6', fontSize: 13 }}
      >
        {LANGS.map((l) => (
          <option key={l} value={l} lang={l}>{LANG_NAME[l]}</option>
        ))}
      </select>
    </span>
  );
}
