'use client';
import { useCallback, useEffect, useState } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import { api, Badge, Button, ConfirmDialog, EmptyRow, ErrorText, PageHeader, Table, td } from '../../../ui';
import { frequencyPhrase, useMailLabels, type ScheduleRow } from '../labels';
import { PreviewDialog } from './preview-dialog';
import { ScheduleDialog } from './schedule-dialog';
import { useT } from '../../../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../../../i18n/format';

type Dialog = { kind: 'create' } | { kind: 'edit' | 'delete' | 'preview'; schedule: ScheduleRow } | null;

export default function MailSchedulesPage() {
  return (
    <RequireCompany>
      <SchedulesInner />
    </RequireCompany>
  );
}

function SchedulesInner() {
  const F = useFmt();
  const M = useMailLabels();
  const T = useT(TEXT);
  const { can, perms } = useShell();
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ schedules: ScheduleRow[] }>('GET', '/api/mail/schedules');
    if (r.ok) {
      setRows(r.data.schedules);
      setLoadError('');
    } else if (!r.redirected) setLoadError(r.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const finish = (text: string) => {
    setDialog(null);
    setNotice({ tone: 'ok', text });
    void load();
  };

  async function toggle(s: ScheduleRow) {
    setNotice(null);
    setBusyId(s.id);
    const r = await api<{ ok: true }>('POST', `/api/mail/schedules/${encodeURIComponent(s.id)}/${s.is_active ? 'deactivate' : 'activate'}`);
    setBusyId(null);
    // 받는 사람이 없거나(NO_RECIPIENTS) 발송될 날이 없으면(NEVER_RUNS) 서버가 409 와 이유를 준다. 그대로 보여 준다.
    if (r.ok) setNotice({ tone: 'ok', text: s.is_active ? T.deactivated(s.name) : T.activated(s.name) });
    else if (!r.redirected) setNotice({ tone: 'error', text: r.error.message });
    void load();
  }

  async function remove(s: ScheduleRow): Promise<string | null> {
    const r = await api<{ ok: true }>('DELETE', `/api/mail/schedules/${encodeURIComponent(s.id)}`);
    // 발송 기록이 있으면 409(IN_USE). 메시지를 대화상자 안에 보여 준다.
    if (!r.ok) return r.redirected ? null : r.error.message;
    finish(T.removed);
    return null;
  }

  const canActivate = can('mail.schedule', 'activate');
  const canDeactivate = can('mail.schedule', 'deactivate');
  const canUpdate = can('mail.schedule', 'update');
  const canDelete = can('mail.schedule', 'delete');
  const head = [T.colName, T.colContent, T.colDept, T.colSchedule, T.colRecipients, T.colState, T.colNext, T.colActions];

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={can('mail.schedule', 'create') ? <Button variant="primary" onClick={() => { setNotice(null); setDialog({ kind: 'create' }); }}>{T.add}</Button> : null}
      />
      <div role="note" style={{ background: '#fef6e4', border: '1px solid #f5d58a', color: '#92400e', borderRadius: 6, padding: '12px 14px', fontSize: 14, marginBottom: 12 }}>
        <strong style={{ display: 'block', marginBottom: 2 }}>{T.noticeTitle}</strong>
        {M.sendingDisabled}
      </div>
      {perms.departmentScope !== null ? <p style={{ fontSize: 13, color: '#4b5563' }}>{T.scopedNote}</p> : null}
      {notice?.tone === 'ok' ? <p role="status" style={{ color: '#166534', fontSize: 14 }}>{notice.text}</p> : null}
      <ErrorText>{notice?.tone === 'error' ? notice.text : loadError}</ErrorText>
      {rows === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {rows ? (
        <Table caption={T.total(rows.length)} head={head}>
          {rows.length === 0 ? <EmptyRow colSpan={head.length}>{T.empty}</EmptyRow> : null}
          {rows.map((s) => (
            <tr key={s.id} style={s.is_active ? undefined : { color: '#4b5563' }}>
              <td style={td}>{s.name}</td>
              <td style={td}>{M.content[s.content_type] ?? s.content_type}</td>
              <td style={td}>{s.department_name ?? T.all}</td>
              <td style={td}>
                {frequencyPhrase(M, s)}
                <div style={{ fontSize: 12, color: '#6b7280' }}>{M.timezone[s.timezone] ?? s.timezone}</div>
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{T.people(s.recipients.length)}</td>
              <td style={td}>{s.is_active ? <Badge tone="green">{T.on}</Badge> : <Badge tone="gray">{T.off}</Badge>}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                {s.is_active && s.next_run_at ? (
                  <>
                    <time dateTime={s.next_run_at}>{F.dateTime(s.next_run_at)}</time>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{T.nextNote}</div>
                  </>
                ) : T.none}
              </td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <Button small onClick={() => { setNotice(null); setDialog({ kind: 'preview', schedule: s }); }}>{T.preview}</Button>
                  {s.is_active && canDeactivate ? <Button small disabled={busyId === s.id} onClick={() => void toggle(s)}>{T.deactivate}</Button> : null}
                  {!s.is_active && canActivate ? <Button small disabled={busyId === s.id} onClick={() => void toggle(s)}>{T.activate}</Button> : null}
                  {canUpdate ? <Button small onClick={() => { setNotice(null); setDialog({ kind: 'edit', schedule: s }); }}>{T.edit}</Button> : null}
                  {canDelete ? <Button small variant="danger" onClick={() => { setNotice(null); setDialog({ kind: 'delete', schedule: s }); }}>{T.remove}</Button> : null}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}

      {dialog?.kind === 'create' ? <ScheduleDialog schedule={null} onClose={() => setDialog(null)} onDone={() => finish(T.created)} /> : null}
      {dialog?.kind === 'edit' ? <ScheduleDialog key={dialog.schedule.id} schedule={dialog.schedule} onClose={() => setDialog(null)} onDone={() => finish(T.saved)} /> : null}
      {dialog?.kind === 'preview' ? <PreviewDialog schedule={dialog.schedule} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmDialog
          title={T.confirmDeleteTitle}
          message={T.confirmDelete(dialog.schedule.name)}
          confirmLabel={T.remove}
          danger
          onConfirm={() => remove(dialog.schedule)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
