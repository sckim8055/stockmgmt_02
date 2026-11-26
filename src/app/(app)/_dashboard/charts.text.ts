// charts.tsx 의 문구. 세 언어의 키는 같아야 한다.
import { dict } from '../../i18n';

export const TEXT = dict({
  ko: {
    showTable: '표로 보기',
    hideTable: '표 숨기기',
    loading: '불러오는 중…',
    empty: '표시할 자료가 없습니다.',
    label: '항목',
    value: '건수',
    share: '비율',
    total: '합계',
    notClickable: '눌러서 거를 수 없는 항목입니다.',
    clickHint: '누르면 이 조건으로 거릅니다.',
  },
  en: {
    showTable: 'Show as table',
    hideTable: 'Hide table',
    loading: 'Loading…',
    empty: 'Nothing to show.',
    label: 'Item',
    value: 'Count',
    share: 'Share',
    total: 'Total',
    notClickable: 'This item cannot be used as a filter.',
    clickHint: 'Click to filter by this.',
  },
  zh: {
    showTable: '以表格查看',
    hideTable: '隐藏表格',
    loading: '加载中…',
    empty: '没有可显示的数据。',
    label: '项目',
    value: '数量',
    share: '占比',
    total: '合计',
    notClickable: '此项目不能用作筛选条件。',
    clickHint: '点击按此条件筛选。',
  },
});
