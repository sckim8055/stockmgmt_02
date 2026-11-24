'use client';
// 미리보기. 서버는 HTML 본문도 주지만 화면에는 글자 본문(text)만 <pre> 안의 글자로 보여 준다.
// HTML 을 문서로 해석해 넣지 않으므로, 모델 이름 같은 값에 태그가 들어 있어도 그냥 글자로 보인다.
import { useEffect, useState } from 'react';
import { api, Button, ErrorText, Modal } from '../../../ui';
import { useMailLabels, type MailPreview, type ScheduleRow } from '../labels';
import { useT } from '../../../i18n';
import { TEXT } from './preview-dialog.text';

export function PreviewDialog({ schedule, onClose }: { schedule: ScheduleRow; onClose: () => void }) {
  const M = useMailLabels();
  const T = useT(TEXT);
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
      <p role="note" style={{ background: '#fef6e4', color: '#92400e', borderRadius: 6, padding: '8px 12px', fontSize: 13, margin: '0 0 12px' }}>{M.sendingDisabled}</p>
      <ErrorText>{error}</ErrorText>
      {data === null && !error ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <p role="status" style={{ fontSize: 14, margin: '0 0 10px', color: data.empty ? '#92400e' : '#166534' }}>
            {data.empty ? (schedule.skip_if_empty ? T.skipped : T.emptySent) : `${T.wouldSend} (${M.content[schedule.content_type]} · ${T.rows(data.rows)})`}
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
