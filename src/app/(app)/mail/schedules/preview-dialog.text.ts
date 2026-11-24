// preview-dialog.tsx 의 화면 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../../i18n';
import { NUM } from '../../../i18n/format';

export const TEXT = dict({
  ko: {
    title: (n: string) => `미리보기 — ${n}`,
    loading: '불러오는 중…',
    subject: '제목',
    body: '본문 (글자 본문)',
    rows: (n: number) => `항목 ${NUM.ko(n)}건`,
    skipped: '보낼 내용이 없습니다. 이 일정은 "내용이 없으면 보내지 않기"가 켜져 있어 지금이라면 발송을 건너뜁니다.',
    emptySent: '보낼 내용이 없습니다. "내용이 없으면 보내지 않기"가 꺼져 있어 지금이라면 "해당하는 항목이 없습니다" 메일이 나갑니다.',
    wouldSend: '지금 발송된다면 아래 내용이 나갑니다.',
    htmlNote: '실제 메일에는 같은 내용이 표 형식(HTML)으로도 들어갑니다.',
    close: '닫기',
  },
  en: {
    title: (n: string) => `Preview — ${n}`,
    loading: 'Loading…',
    subject: 'Subject',
    body: 'Body (plain text)',
    rows: (n: number) => `${NUM.en(n)} ${n === 1 ? 'item' : 'items'}`,
    skipped: 'There is nothing to send. "Skip when there is nothing to send" is on for this schedule, so it would be skipped right now.',
    emptySent: 'There is nothing to send. "Skip when there is nothing to send" is off, so a "no matching items" mail would be sent right now.',
    wouldSend: 'If sent now, the mail would contain the following.',
    htmlNote: 'The actual mail also includes the same content as a table (HTML).',
    close: 'Close',
  },
  zh: {
    title: (n: string) => `预览 — ${n}`,
    loading: '加载中…',
    subject: '主题',
    body: '正文（纯文本）',
    rows: (n: number) => `共 ${NUM.zh(n)} 项`,
    skipped: '没有可发送的内容。此计划已开启“无内容时不发送”，如果现在发送将会跳过。',
    emptySent: '没有可发送的内容。由于“无内容时不发送”已关闭，如果现在发送，将发出一封“没有符合条件的项目”的邮件。',
    wouldSend: '如果现在发送，邮件内容如下。',
    htmlNote: '实际邮件中还会以表格（HTML）形式包含相同内容。',
    close: '关闭',
  },
});
