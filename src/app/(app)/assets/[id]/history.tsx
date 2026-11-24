'use client';
import { useEffect, useState } from 'react';
import { api, ErrorText } from '../../../ui';
import { stateText, TXN_LABEL } from '../labels';
import { fmtDateTime } from '../shared';
import type { HistoryRow } from '../types';

const T = {
  title: '이력',
  loading: '불러오는 중…',
  empty: '이력이 없습니다.',
  state: '상태',
  holder: '보유자',
  dept: '관리 부서',
  location: '위치',
  note: '메모',
  changed: '바뀐 항목',
  none: '없음',
  by: (name: string) => `처리: ${name}`,
  unknownActor: '알 수 없음',
};

/** 수정 이력의 메모("changed: a, b")에 들어 있는 입력 키의 표시 이름 */
const FIELD_LABEL: Record<string, string> = {
  modelId: '모델',
  assetTag: '자산 태그',
  serialNumber: '시리얼',
  departmentId: '관리 부서',
  location: '위치',
  purchaseDate: '구매일',
  purchasePrice: '구매가',
  supplier: '공급업체',
  warrantyEnd: '보증 만료일',
  custom: '사용자 지정 필드',
};
const CHANGED_PREFIX = 'changed: ';

function changedFields(note: string): string {
  return note
    .slice(CHANGED_PREFIX.length)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => FIELD_LABEL[k] ?? k)
    .join(', ');
}

/** 이력(최신순). 서버가 최신순으로 내려준다. */
export function AssetHistory({ assetId, reloadKey }: { assetId: string; reloadKey: number }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await api<{ history: HistoryRow[] }>('GET', `/api/assets/${encodeURIComponent(assetId)}/history`);
      if (!live) return;
      if (r.ok) {
        setRows(r.data.history);
        setError('');
      } else if (!r.redirected) setError(r.error.message);
    })();
    return () => {
      live = false;
    };
  }, [assetId, reloadKey]);

  return (
    <section aria-labelledby="asset-history-title" style={{ marginTop: 20 }}>
      <h2 id="asset-history-title" style={{ fontSize: 16, margin: '0 0 8px' }}>{T.title}</h2>
      <ErrorText>{error}</ErrorText>
      {rows === null && !error ? <p style={{ color: '#6b7280', fontSize: 14 }}>{T.loading}</p> : null}
      {rows && rows.length === 0 ? <p style={{ color: '#6b7280', fontSize: 14 }}>{T.empty}</p> : null}
      {rows && rows.length > 0 ? (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, borderLeft: '2px solid #e2e5ea' }}>
          {rows.map((h) => (
            <HistoryItem key={h.id} h={h} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function HistoryItem({ h }: { h: HistoryRow }) {
  const lines: [string, string][] = [];
  const stateChanged = h.to_state !== null && (h.from_state !== h.to_state || h.from_substate !== h.to_substate);
  if (stateChanged) {
    const from = h.from_state ? stateText(h.from_state, h.from_substate) : null;
    lines.push([T.state, from ? `${from} → ${stateText(h.to_state as string, h.to_substate)}` : stateText(h.to_state as string, h.to_substate)]);
  }
  if (h.from_holder_name !== h.to_holder_name) lines.push([T.holder, `${h.from_holder_name ?? T.none} → ${h.to_holder_name ?? T.none}`]);
  if (h.from_department_name !== h.to_department_name) {
    lines.push([T.dept, h.from_department_name ? `${h.from_department_name} → ${h.to_department_name ?? T.none}` : (h.to_department_name ?? T.none)]);
  }
  if (h.from_location !== h.to_location) lines.push([T.location, `${h.from_location ?? T.none} → ${h.to_location ?? T.none}`]);
  if (h.note) {
    if (h.type === 'UPDATE' && h.note.startsWith(CHANGED_PREFIX)) lines.push([T.changed, changedFields(h.note)]);
    else lines.push([T.note, h.note]);
  }

  return (
    <li style={{ position: 'relative', padding: '0 0 14px 16px' }}>
      <span aria-hidden style={{ position: 'absolute', left: -6, top: 5, width: 10, height: 10, borderRadius: 5, background: '#2563eb' }} />
      <div style={{ fontSize: 14 }}>
        <strong>{TXN_LABEL[h.type] ?? h.type}</strong>
        <span style={{ color: '#6b7280', fontSize: 13 }}>
          {' · '}
          <time dateTime={h.created_at}>{fmtDateTime(h.created_at)}</time>
          {' · '}
          {T.by(h.actor_name ?? T.unknownActor)}
        </span>
      </div>
      {lines.length > 0 ? (
        <dl style={{ margin: '4px 0 0', display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 10px', fontSize: 13 }}>
          {lines.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt style={{ color: '#6b7280' }}>{k}</dt>
              <dd style={{ margin: 0 }}>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}
