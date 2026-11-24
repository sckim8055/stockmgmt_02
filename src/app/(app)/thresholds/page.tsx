'use client';
import { useCallback, useEffect, useState } from 'react';
import { RequireCompany, useShell } from '../../shell';
import { api, Badge, Button, ConfirmDialog, EmptyRow, ErrorText, Notice, PageHeader, Table, td } from '../../ui';
import { fmtDateTime } from '../assets/shared';
import { fmtQty } from '../peripherals/labels';
import { fmtRatio, KIND_LABEL, KIND_TONE, recoverAt, TARGET_TYPE_LABEL, type ThresholdRow } from './labels';
import { CreateThresholdDialog, EditThresholdDialog } from './threshold-dialog';

const T = {
  title: '한계 수량',
  add: '한계 수량 추가',
  loading: '불러오는 중…',
  empty: '등록된 한계 수량이 없습니다.',
  intro: '사용 가능 수량(자산은 재고·사용 가능 상태의 대수, 주변기기는 보유 수량)이 한계 수량보다 적어지면 알림함으로 알립니다.',
  scopedNote: '내 부서 범위의 한계 수량만 보입니다. 기업 전체 한계 수량은 부서 범위 제한이 없는 사용자만 보고 관리합니다.',
  colTarget: '대상',
  colDept: '부서',
  colQty: '현재 수량',
  colMin: '한계 수량',
  colRecover: '회복 기준',
  colState: '상태',
  colLastAlert: '마지막 부족 알림',
  colActions: '작업',
  all: '전체',
  stateLow: '부족',
  stateOk: '정상',
  stateOff: '사용 안 함',
  ratio: (r: string) => `× ${r}`,
  never: '-',
  edit: '수정',
  remove: '삭제',
  created: '한계 수량을 추가했습니다.',
  saved: '저장했습니다.',
  removed: '삭제했습니다.',
  confirmDeleteTitle: '한계 수량 삭제',
  confirmDelete: (n: string, d: string) => `"${n}" (${d}) 한계 수량을 삭제합니다. 이 대상의 부족 알림이 더 이상 만들어지지 않습니다.`,
  total: (n: number) => `총 ${n.toLocaleString('ko-KR')}건`,
};

type Dialog = { kind: 'create' } | { kind: 'edit' | 'delete'; threshold: ThresholdRow } | null;

export default function ThresholdsPage() {
  return (
    <RequireCompany>
      <ThresholdsInner />
    </RequireCompany>
  );
}

function ThresholdsInner() {
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
                  <Badge tone={KIND_TONE[t.kind]}>{KIND_LABEL[t.kind]}</Badge>
                  {t.target_name}
                  <span style={{ color: '#6b7280', fontSize: 12 }}> ({t.category_id ? TARGET_TYPE_LABEL.category : TARGET_TYPE_LABEL.model})</span>
                </td>
                <td style={td}>{t.department_name ?? T.all}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: low ? 600 : undefined, color: low ? '#991b1b' : undefined }}>{fmtQty(t.qty)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{fmtQty(t.min_qty)}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {fmtQty(recoverAt(t))}
                  <span style={{ color: '#6b7280', fontSize: 12 }}> {T.ratio(fmtRatio(t.warn_ratio))}</span>
                </td>
                <td style={td}>
                  {!t.is_active ? <Badge tone="gray">{T.stateOff}</Badge> : low ? <Badge tone="red">{T.stateLow}</Badge> : <Badge tone="green">{T.stateOk}</Badge>}
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {t.last_alert_at ? <time dateTime={t.last_alert_at}>{fmtDateTime(t.last_alert_at)}</time> : T.never}
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
