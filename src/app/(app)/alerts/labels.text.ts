// 알림 종류의 이름과 알림 문장. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
// 숫자(qty·min)는 화면이 현재 언어로 이미 형식을 맞춘 글자로 넘긴다.
import { dict } from '../../i18n';

export const TEXT = dict({
  ko: {
    type: { LOW_STOCK: '재고 부족', STOCK_RECOVERED: '재고 회복', WARRANTY_EXPIRING: '보증 만료 임박', LOAN_OVERDUE: '반납 기한 지남' },
    all: '전체',
    noHolder: '보유자 없음',
    lowStock: (target: string, dept: string, qty: string, min: string) => `${target} (${dept}) 사용 가능 수량이 ${qty}개로 한계 수량 ${min}개보다 적습니다.`,
    recovered: (target: string, dept: string, qty: string, min: string) => `${target} (${dept}) 사용 가능 수량이 ${qty}개로 회복되었습니다. (한계 수량 ${min}개)`,
    warranty: (tag: string, model: string, end: string) => `자산 ${tag} (${model})의 보증이 ${end}에 끝납니다.`,
    assetOverdue: (tag: string, holder: string, due: string) => `자산 ${tag}의 반납 기한(${due})이 지났습니다. 보유자: ${holder}`,
    loanOverdue: (holder: string, model: string, qty: string, due: string) => `${holder} 님이 대여한 ${model} ${qty}개의 반납 기한(${due})이 지났습니다.`,
  },
  en: {
    type: { LOW_STOCK: 'Low stock', STOCK_RECOVERED: 'Stock recovered', WARRANTY_EXPIRING: 'Warranty expiring', LOAN_OVERDUE: 'Overdue return' },
    all: 'All',
    noHolder: 'no holder',
    lowStock: (target: string, dept: string, qty: string, min: string) => `${target} (${dept}): available quantity is ${qty}, below the minimum stock of ${min}.`,
    recovered: (target: string, dept: string, qty: string, min: string) => `${target} (${dept}): available quantity has recovered to ${qty}. (Minimum stock ${min})`,
    warranty: (tag: string, model: string, end: string) => `The warranty for asset ${tag} (${model}) ends on ${end}.`,
    assetOverdue: (tag: string, holder: string, due: string) => `Asset ${tag} was due back on ${due}. Holder: ${holder}`,
    loanOverdue: (holder: string, model: string, qty: string, due: string) => `${qty} × ${model} loaned to ${holder} were due back on ${due}.`,
  },
  zh: {
    type: { LOW_STOCK: '库存不足', STOCK_RECOVERED: '库存恢复', WARRANTY_EXPIRING: '保修即将到期', LOAN_OVERDUE: '归还逾期' },
    all: '全部',
    noHolder: '无持有人',
    lowStock: (target: string, dept: string, qty: string, min: string) => `${target}（${dept}）可用数量为 ${qty} 个，低于最低库存 ${min} 个。`,
    recovered: (target: string, dept: string, qty: string, min: string) => `${target}（${dept}）可用数量已恢复至 ${qty} 个。（最低库存 ${min} 个）`,
    warranty: (tag: string, model: string, end: string) => `资产 ${tag}（${model}）的保修将于 ${end} 到期。`,
    assetOverdue: (tag: string, holder: string, due: string) => `资产 ${tag} 已超过归还期限（${due}）。持有人：${holder}`,
    loanOverdue: (holder: string, model: string, qty: string, due: string) => `${holder} 借用的 ${model} ${qty} 个已超过归还期限（${due}）。`,
  },
});
