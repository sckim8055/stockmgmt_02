// 한계 수량 화면의 표시 이름. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../i18n';

export const TEXT = dict({
  ko: {
    kind: { ASSET: '자산', PERIPHERAL: '주변기기' },
    targetType: { category: '카테고리', model: '모델' },
  },
  en: {
    kind: { ASSET: 'Asset', PERIPHERAL: 'Peripheral' },
    targetType: { category: 'Category', model: 'Model' },
  },
  zh: {
    kind: { ASSET: '资产', PERIPHERAL: '外设' },
    targetType: { category: '类别', model: '型号' },
  },
});
