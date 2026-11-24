// 언어 이름과 언어 선택 문구.
import { dict, type Lang } from './index';

/** 언어 이름은 그 언어로 쓴다(어느 화면 언어에서든 같다). */
export const LANG_NAME: Record<Lang, string> = {
  ko: '한국어',
  en: 'English',
  zh: '中文',
};

export const TEXT = dict({
  ko: { label: '화면 언어', hint: '이 브라우저에만 적용됩니다.' },
  en: { label: 'Display language', hint: 'Applies to this browser only.' },
  zh: { label: '界面语言', hint: '仅对此浏览器生效。' },
});
