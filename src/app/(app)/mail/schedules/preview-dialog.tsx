'use client';
// 미리보기. 서버는 HTML 본문도 주지만 화면에는 글자 본문(text)만 <pre> 안의 글자로 보여 준다.
// HTML 을 문서로 해석해 넣지 않으므로, 모델 이름 같은 값에 태그가 들어 있어도 그냥 글자로 보인다.
import { useEffect, useState } from 'react';
import { api, Button, ErrorText, Modal } from '../../../ui';
import { CONTENT_LABEL, SENDING_DISABLED, type MailPreview, type ScheduleRow } from '../labels';

const T = {
  title: (n: string) => `미리보기 — ${n}`,
  loading: '불러오는 중…',
  subject: '제목',
  body: '본문 (글자 본문)',
  rows: (n: number) => `항목 ${n.toLocaleString('ko-KR')}건`,
  skipped: '보낼 내용이 없습니다. 이 일정은 "내용이 없으면 보내지 않기"가 켜져 있어 지금이라면 발송을 건너뜁니다.',
  emptySent: '보낼 내용이 없습니다. "내용이 없으면 보내지 않기"가 꺼져 있어 지금이라면 "해당하는 항목이 없습니다" 메일이 나갑니다.',
  wouldSend: '지금 발송된다면 아래 내용이 나갑니다.',
  htmlNote: '실제 메일에는 같은 내용이 표 형식(HTML)으로도 들어갑니다.',
  close: '닫기',
};

export function PreviewDialog({ schedule, onClose }: { schedule: ScheduleRow; onClose: () => void }) {
  const [data, setData] = useState<MailPreview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await api<MailPreview>('GET', `/api/mail/schedules/${encodeURIComponent(schedule.id)}/preview`);
      if (!live) return;
      if (r.ok) setData(r.data);
      else if (!r.redirected) setError(r.error.message);
    })();
    return () => {
      live = false;
    };
  }, [schedule.id]);

  return (
    <Modal title={T.title(schedule.name)} onClose={onClose} width={760} footer={<Button onClick={onClose}>{T.close}</Button>}>
      <p role="note" style={{ background: '#fef6e4', color: '#92400e', borderRadius: 6, padding: '8px 12px', fontSize: 13, margin: '0 0 12px' }}>{SENDING_DISABLED}</p>
      <ErrorText>{error}</ErrorText>
      {data === null && !error ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <p role="status" style={{ fontSize: 14, margin: '0 0 10px', color: data.empty ? '#92400e' : '#166534' }}>
            {data.empty ? (schedule.skip_if_empty ? T.skipped : T.emptySent) : `${T.wouldSend} (${CONTENT_LABEL[schedule.content_type]} · ${T.rows(data.rows)})`}
          </p>
          <div style={{ fontSize: 13, color: '#4b5563' }}>{T.subject}</div>
          <p style={{ fontSize: 15, fontWeight: 600, margin: '2px 0 12px' }}>{data.subject}</p>
          <div style={{ fontSize: 13, color: '#4b5563' }}>{T.body}</div>
          <pre
            style={{
              margin: '4px 0 6px', padding: '10px 12px', background: '#f8f9fb', border: '1px solid #e2e5ea', borderRadius: 6,
              fontSize: 13, lineHeight: 1.5, maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}
          >
            {data.text}
          </pre>
          <div style={{ fontSize: 12, color: '#6b7280' }}>{T.htmlNote}</div>
        </>
      ) : null}
    </Modal>
  );
}
