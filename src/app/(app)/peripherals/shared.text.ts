// shared.tsx 의 화면 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../i18n';
import { NUM } from '../../i18n/format';

export const TEXT = dict({
  ko: {
    page: (p: number, last: number) => `${p} / ${last} 쪽`,
    pageOnly: (p: number) => `${p} 쪽`,
    prev: '이전',
    next: '다음',
    qtyInvalid: (min: number) => `수량은 ${min} 이상의 정수로 입력하세요.`,
    qtyTooMany: (max: number) => `수량이 너무 많습니다. (최대 ${NUM.ko(max)}개)`,
    qtyHint: (max: number) => `최대 ${NUM.ko(max)}개`,
  },
  en: {
    page: (p: number, last: number) => `Page ${p} of ${last}`,
    pageOnly: (p: number) => `Page ${p}`,
    prev: 'Previous',
    next: 'Next',
    qtyInvalid: (min: number) => `Enter a whole number of ${min} or more.`,
    qtyTooMany: (max: number) => `Quantity is too large (max ${NUM.en(max)}).`,
    qtyHint: (max: number) => `Max ${NUM.en(max)}`,
  },
  zh: {
    page: (p: number, last: number) => `第 ${p} / ${last} 页`,
    pageOnly: (p: number) => `第 ${p} 页`,
    prev: '上一页',
    next: '下一页',
    qtyInvalid: (min: number) => `数量请输入不小于 ${min} 的整数。`,
    qtyTooMany: (max: number) => `数量过大（最多 ${NUM.zh(max)} 个）。`,
    qtyHint: (max: number) => `最多 ${NUM.zh(max)} 个`,
  },
});
