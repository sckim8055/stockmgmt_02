// login/page.tsx 의 화면 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../i18n';

export const TEXT = dict({
  ko: {
    title: 'StockMgmt 로그인',
    companyCode: '기업코드',
    loginId: '로그인 ID',
    password: '비밀번호',
    failed: '로그인에 실패했습니다.',
    checking: '확인 중…',
    submit: '로그인',
  },
  en: {
    title: 'Sign in to StockMgmt',
    companyCode: 'Company code',
    loginId: 'Login ID',
    password: 'Password',
    failed: 'Sign-in failed.',
    checking: 'Signing in…',
    submit: 'Sign in',
  },
  zh: {
    title: '登录 StockMgmt',
    companyCode: '企业代码',
    loginId: '登录 ID',
    password: '密码',
    failed: '登录失败。',
    checking: '正在验证…',
    submit: '登录',
  },
});
