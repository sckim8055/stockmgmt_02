// shared.tsx 의 화면 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../i18n';

export const TEXT = dict({
  ko: {
    from: '시작일',
    to: '종료일',
    rangeHint: '날짜는 기업의 시간대 기준입니다. 종료일 당일까지 포함합니다.',
    rangeInvalid: '시작일이 종료일보다 늦습니다.',
  },
  en: {
    from: 'From',
    to: 'To',
    rangeHint: "Dates are in the company's time zone. The end date is inclusive.",
    rangeInvalid: 'The start date is after the end date.',
  },
  zh: {
    from: '开始日期',
    to: '结束日期',
    rangeHint: '日期按企业所在时区计算，包含结束日期当天。',
    rangeInvalid: '开始日期晚于结束日期。',
  },
});
