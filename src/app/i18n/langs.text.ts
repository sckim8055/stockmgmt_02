// 언어 이름과 언어 선택 문구.
import { dict, type Lang } from './index';

/** 언어 이름은 그 언어로 쓴다(어느 화면 언어에서든 같다). */
export const LANG_NAME: Record<Lang, string> = {
  ko: '한국어',
  en: 'English',
  zh: '中文',
};

export const TEXT = dict({
  ko: { label: '화면 언어', hint: '이 브라우저에 기억되고, 로그인한 계정에도 저장됩니다.' },
  en: { label: 'Display language', hint: 'Remembered in this browser and saved to your account when signed in.' },
  zh: { label: '界面语言', hint: '会记在此浏览器中，登录后也会保存到您的账号。' },
});
