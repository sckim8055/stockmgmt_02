'use client';
import { useCallback, useEffect, useState } from 'react';
import { RequireCompany, useShell } from '../../shell';
import { api, Badge, Button, ConfirmDialog, EmptyRow, ErrorText, Notice, PageHeader, Table, td } from '../../ui';
import { KIND_TONE, recoverAt, useThresholdLabels, type ThresholdRow } from './labels';
import { CreateThresholdDialog, EditThresholdDialog } from './threshold-dialog';
import { useT } from '../../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../../i18n/format';

type Dialog = { kind: 'create' } | { kind: 'edit' | 'delete'; threshold: ThresholdRow } | null;

export default function ThresholdsPage() {
  return (
    <RequireCompany>
      <ThresholdsInner />
    </RequireCompany>
  );
}

function ThresholdsInner() {
  const F = useFmt();
  const TL = useThresholdLabels();
  const T = useT(TEXT);
  const { can, perms } = useShell();
  const [rows, setRows] = useState<ThresholdRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);

  const load = useCallback(async () => {
    const r = await api<{ thresholds: ThresholdRow[] }>('GET', '/api/thresholds');
    if (r.ok) {
      setRows(r.data.thresholds);
      setLoadError('');
    } else if (!r.redirected) setLoadError(r.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const finish = (text: string) => {
    setDialog(null);
    setNotice(text);
    void load();
  };

  async function remove(t: ThresholdRow): Promise<string | null> {
    const r = await api<{ ok: true }>('DELETE', `/api/thresholds/${encodeURIComponent(t.id)}`);
    if (!r.ok) return r.redirected ? null : r.error.message;
    finish(T.removed);
    return null;
  }

  const canUpdate = can('threshold', 'update');
  const canDelete = can('threshold', 'delete');
  const hasActions = canUpdate || canDelete;
  const head = [T.colTarget, T.colDept, T.colQty, T.colMin, T.colRecover, T.colState, T.colLastAlert, ...(hasActions ? [T.colActions] : [])];

  return (
    <div>
      <PageHeader
        title={T.title}
        actions={can('threshold', 'create') ? <Button variant="primary" onClick={() => { setNotice(''); setDialog({ kind: 'create' }); }}>{T.add}</Button> : null}
      />
      <p style={{ fontSize: 13, color: '#4b5563', marginTop: 0 }}>{T.intro}</p>
      {perms.departmentScope !== null ? <Notice>{T.scopedNote}</Notice> : null}
      {notice ? <p role="status" style={{ color: '#166534', fontSize: 14 }}>{notice}</p> : null}
      <ErrorText>{loadError}</ErrorText>
      {rows === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {rows ? (
        <Table caption={T.total(rows.length)} head={head}>
          {rows.length === 0 ? <EmptyRow colSpan={head.length}>{T.empty}</EmptyRow> : null}
          {rows.map((t) => {
            const low = t.is_active && t.state === 'LOW';
            return (
              <tr key={t.id} style={low ? { background: '#fff7f7' } : t.is_active ? undefined : { color: '#6b7280' }}>
                <td style={td}>
                  <Badge tone={KIND_TONE[t.kind]}>{TL.kind[t.kind]}</Badge>
                  {t.target_name}
                  <span style={{ color: '#6b7280', fontSize: 12 }}> ({t.category_id ? TL.targetType.category : TL.targetType.model})</span>
                </td>
                <td style={td}>{t.department_name ?? T.all}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: low ? 600 : undefined, color: low ? '#991b1b' : undefined }}>{F.num(t.qty)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{F.num(t.min_qty)}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {F.num(recoverAt(t))}
                  <span style={{ color: '#6b7280', fontSize: 12 }}> {T.ratio(F.decimal(t.warn_ratio))}</span>
                </td>
                <td style={td}>
                  {!t.is_active ? <Badge tone="gray">{T.stateOff}</Badge> : low ? <Badge tone="red">{T.stateLow}</Badge> : <Badge tone="green">{T.stateOk}</Badge>}
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {t.last_alert_at ? <time dateTime={t.last_alert_at}>{F.dateTime(t.last_alert_at)}</time> : T.never}
                </td>
                {hasActions ? (
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {canUpdate ? <Button small onClick={() => { setNotice(''); setDialog({ kind: 'edit', threshold: t }); }}>{T.edit}</Button> : null}
                      {canDelete ? <Button small variant="danger" onClick={() => { setNotice(''); setDialog({ kind: 'delete', threshold: t }); }}>{T.remove}</Button> : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </Table>
      ) : null}

      {dialog?.kind === 'create' ? <CreateThresholdDialog onClose={() => setDialog(null)} onDone={() => finish(T.created)} /> : null}
      {dialog?.kind === 'edit' ? <EditThresholdDialog threshold={dialog.threshold} onClose={() => setDialog(null)} onDone={() => finish(T.saved)} /> : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmDialog
          title={T.confirmDeleteTitle}
          message={T.confirmDelete(dialog.threshold.target_name, dialog.threshold.department_name ?? T.all)}
          confirmLabel={T.remove}
          danger
          onConfirm={() => remove(dialog.threshold)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
