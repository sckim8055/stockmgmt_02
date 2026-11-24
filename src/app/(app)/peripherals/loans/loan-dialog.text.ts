// loan-dialog.tsx 의 화면 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../../i18n';
import { NUM } from '../../../i18n/format';

export const TEXT = dict({
  ko: {
    title: { RETURN: '반납', LOAN_LOSS: '분실 처리' },
    summary: (person: string, model: string, n: number) => `${person} · ${model} · 미반납 ${NUM.ko(n)}개`,
    returnIntro: '돌려받은 수량만큼 보유 수량에 다시 더합니다. 일부만 반납하면 대여는 미반납으로 남습니다.',
    lossWarn: '분실 처리한 수량은 재고로 돌아오지 않습니다. 대여 중 수량에서만 빠지고, 보유 수량은 그대로입니다. 되돌릴 수 없습니다.',
    fQty: { RETURN: '반납 수량', LOAN_LOSS: '분실 수량' },
    fNote: { RETURN: '메모 (선택)', LOAN_LOSS: '메모 (선택, 분실 경위 등)' },
    confirm: '분실 수량은 재고로 돌아오지 않는다는 것을 확인했습니다.',
    done: { RETURN: (n: number) => `반납했습니다. (남은 미반납 ${NUM.ko(n)}개)`, LOAN_LOSS: (n: number) => `분실 처리했습니다. (남은 미반납 ${NUM.ko(n)}개)` },
    cancel: '취소',
    processing: '처리 중…',
  },
  en: {
    title: { RETURN: 'Return', LOAN_LOSS: 'Record loss' },
    summary: (person: string, model: string, n: number) => `${person} · ${model} · ${NUM.en(n)} outstanding`,
    returnIntro: 'The returned quantity is added back to stock on hand. If only part is returned, the loan stays outstanding.',
    lossWarn: 'Lost items do not return to stock. They are removed only from the on-loan quantity; stock on hand is unchanged. This cannot be undone.',
    fQty: { RETURN: 'Quantity returned', LOAN_LOSS: 'Quantity lost' },
    fNote: { RETURN: 'Note (optional)', LOAN_LOSS: 'Note (optional, e.g. how it was lost)' },
    confirm: 'I understand that lost items do not return to stock.',
    done: { RETURN: (n: number) => `Returned. (${NUM.en(n)} still outstanding)`, LOAN_LOSS: (n: number) => `Loss recorded. (${NUM.en(n)} still outstanding)` },
    cancel: 'Cancel',
    processing: 'Processing…',
  },
  zh: {
    title: { RETURN: '归还', LOAN_LOSS: '登记丢失' },
    summary: (person: string, model: string, n: number) => `${person} · ${model} · 未归还 ${NUM.zh(n)} 个`,
    returnIntro: '归还的数量会加回在库数量。若只归还一部分，该借用仍保持未归还状态。',
    lossWarn: '登记丢失的数量不会回到库存，只从借出数量中扣除，在库数量不变。此操作无法撤销。',
    fQty: { RETURN: '归还数量', LOAN_LOSS: '丢失数量' },
    fNote: { RETURN: '备注（可选）', LOAN_LOSS: '备注（可选，如丢失经过）' },
    confirm: '我已了解丢失的数量不会回到库存。',
    done: { RETURN: (n: number) => `已归还。（剩余未归还 ${NUM.zh(n)} 个）`, LOAN_LOSS: (n: number) => `已登记丢失。（剩余未归还 ${NUM.zh(n)} 个）` },
    cancel: '取消',
    processing: '处理中…',
  },
});
