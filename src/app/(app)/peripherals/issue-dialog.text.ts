// issue-dialog.tsx 의 화면 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../i18n';
import { NUM } from '../../i18n/format';

export const TEXT = dict({
  ko: {
    title: { ISSUE: '지급', LOAN: '대여' },
    intro: {
      ISSUE: '돌려받지 않는 지급입니다. 보유 수량에서 빠집니다.',
      LOAN: '돌려받을 대여입니다. 반납·분실은 대여 현황에서 처리합니다.',
    },
    available: (n: number) => `현재 보유 ${NUM.ko(n)}개`,
    fPerson: '받는 직원',
    fQty: '수량',
    fDue: '반납 기한 (선택)',
    fLocation: '사용 위치 메모 (선택)',
    fNote: '메모 (선택)',
    personRequired: '받는 직원을 고르세요.',
    personUnavailable: '직원 명부를 볼 권한이 없어 받는 직원을 고를 수 없습니다.',
    done: { ISSUE: (n: number) => `지급했습니다. (남은 보유 ${NUM.ko(n)}개)`, LOAN: (n: number) => `대여했습니다. (남은 보유 ${NUM.ko(n)}개)` },
    cancel: '취소',
    processing: '처리 중…',
  },
  en: {
    title: { ISSUE: 'Issue', LOAN: 'Loan' },
    intro: {
      ISSUE: 'An issue is not returned. It is deducted from stock on hand.',
      LOAN: 'A loan is expected back. Record returns and losses under Loans.',
    },
    available: (n: number) => `${NUM.en(n)} on hand`,
    fPerson: 'Employee',
    fQty: 'Quantity',
    fDue: 'Return by (optional)',
    fLocation: 'Where it is used (optional)',
    fNote: 'Note (optional)',
    personRequired: 'Select an employee.',
    personUnavailable: 'You cannot select an employee because you do not have permission to view the employee directory.',
    done: { ISSUE: (n: number) => `Issued. (${NUM.en(n)} left on hand)`, LOAN: (n: number) => `Loaned. (${NUM.en(n)} left on hand)` },
    cancel: 'Cancel',
    processing: 'Processing…',
  },
  zh: {
    title: { ISSUE: '发放', LOAN: '借用' },
    intro: {
      ISSUE: '发放后无需归还，将从在库数量中扣除。',
      LOAN: '借用需要归还。归还和丢失请在“借用情况”中处理。',
    },
    available: (n: number) => `当前在库 ${NUM.zh(n)} 个`,
    fPerson: '接收员工',
    fQty: '数量',
    fDue: '归还期限（可选）',
    fLocation: '使用位置备注（可选）',
    fNote: '备注（可选）',
    personRequired: '请选择接收员工。',
    personUnavailable: '您没有查看员工名册的权限，无法选择接收员工。',
    done: { ISSUE: (n: number) => `已发放。（剩余在库 ${NUM.zh(n)} 个）`, LOAN: (n: number) => `已借出。（剩余在库 ${NUM.zh(n)} 个）` },
    cancel: '取消',
    processing: '处理中…',
  },
});
