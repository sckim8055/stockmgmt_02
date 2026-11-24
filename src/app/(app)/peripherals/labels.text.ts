// 주변기기의 이력 종류·대여 상태의 화면 이름. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../i18n';

export const TEXT = dict({
  ko: {
    txn: { INITIAL: '최초 등록', RECEIVE: '입고', ISSUE: '지급', LOAN: '대여', RETURN: '반납', LOAN_LOSS: '대여 분실', DISPOSE: '폐기', ADJUST: '실사 조정' },
    loanStatus: { OPEN: '미반납', CLOSED: '종료' },
    loanFilter: { OPEN: '미반납', CLOSED: '종료', ALL: '전체' },
  },
  en: {
    txn: { INITIAL: 'Initial stock', RECEIVE: 'Receive', ISSUE: 'Issue', LOAN: 'Loan', RETURN: 'Return', LOAN_LOSS: 'Lost on loan', DISPOSE: 'Dispose', ADJUST: 'Stock count adjustment' },
    loanStatus: { OPEN: 'Outstanding', CLOSED: 'Closed' },
    loanFilter: { OPEN: 'Outstanding', CLOSED: 'Closed', ALL: 'All' },
  },
  zh: {
    txn: { INITIAL: '初始登记', RECEIVE: '入库', ISSUE: '发放', LOAN: '借用', RETURN: '归还', LOAN_LOSS: '借用丢失', DISPOSE: '报废', ADJUST: '盘点调整' },
    loanStatus: { OPEN: '未归还', CLOSED: '已结束' },
    loanFilter: { OPEN: '未归还', CLOSED: '已结束', ALL: '全部' },
  },
});
