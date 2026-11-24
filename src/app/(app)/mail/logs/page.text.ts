// page.tsx 의 화면 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../../i18n';
import { NUM } from '../../../i18n/format';

export const TEXT = dict({
  ko: {
    title: '발송 기록',
    loading: '불러오는 중…',
    empty: '아직 발송된 메일이 없습니다.',
    colTime: '시각',
    colRecipient: '받는 사람',
    colSubject: '제목',
    colStatus: '상태',
    colError: '오류',
    none: '',
    total: (n: number) => `총 ${NUM.ko(n)}건`,
  },
  en: {
    title: 'Delivery log',
    loading: 'Loading…',
    empty: 'No mail has been sent yet.',
    colTime: 'Time',
    colRecipient: 'Recipient',
    colSubject: 'Subject',
    colStatus: 'Status',
    colError: 'Error',
    none: '',
    total: (n: number) => `${NUM.en(n)} ${n === 1 ? 'entry' : 'entries'}`,
  },
  zh: {
    title: '发送记录',
    loading: '加载中…',
    empty: '尚未发送任何邮件。',
    colTime: '时间',
    colRecipient: '收件人',
    colSubject: '主题',
    colStatus: '状态',
    colError: '错误',
    none: '',
    total: (n: number) => `共 ${NUM.zh(n)} 条`,
  },
});
