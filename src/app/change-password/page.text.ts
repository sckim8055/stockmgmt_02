// change-password/page.tsx 의 화면 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../i18n';

export const TEXT = dict({
  ko: {
    title: '비밀번호 변경',
    rule: '10자 이상, 영문 대·소문자·숫자·기호 중 3가지 이상을 섞어야 합니다.',
    current: '현재(임시) 비밀번호',
    next: '새 비밀번호',
    confirm: '새 비밀번호 확인',
    mismatch: '새 비밀번호가 서로 다릅니다.',
    failed: '변경에 실패했습니다.',
    changing: '변경 중…',
    submit: '변경',
  },
  en: {
    title: 'Change password',
    rule: 'Use at least 10 characters and mix at least 3 of: uppercase letters, lowercase letters, digits and symbols.',
    current: 'Current (temporary) password',
    next: 'New password',
    confirm: 'Confirm new password',
    mismatch: 'The new passwords do not match.',
    failed: 'Could not change the password.',
    changing: 'Changing…',
    submit: 'Change password',
  },
  zh: {
    title: '修改密码',
    rule: '至少 10 个字符，并包含大写字母、小写字母、数字、符号中的至少 3 种。',
    current: '当前（临时）密码',
    next: '新密码',
    confirm: '确认新密码',
    mismatch: '两次输入的新密码不一致。',
    failed: '密码修改失败。',
    changing: '修改中…',
    submit: '修改',
  },
});
