'use client';
import { useEffect, useState } from 'react';
import { api, ErrorText } from '../../../ui';
import { stateText, useAssetLabels } from '../labels';
import type { HistoryRow } from '../types';
import { useT } from '../../../i18n';
import { TEXT } from './history.text';
import { useFmt } from '../../../i18n/format';

const CHANGED_PREFIX = 'changed: ';

/** 수정 이력의 메모("changed: a, b")를 바뀐 항목 이름으로 바꾼다. 형식이 다르면 null. */
export function changedFields(note: string, fieldLabel: Record<string, string>): string | null {
  if (!note.startsWith(CHANGED_PREFIX)) return null;
  return note
    .slice(CHANGED_PREFIX.length)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => fieldLabel[k] ?? k)
    .join(', ');
}

/** 이력(최신순). 서버가 최신순으로 내려준다. */
export function AssetHistory({ assetId, reloadKey }: { assetId: string; reloadKey: number }) {
  const T = useT(TEXT);
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
      {rows === null && !error ? <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{T.loading}</p> : null}
      {rows && rows.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{T.empty}</p> : null}
      {rows && rows.length > 0 ? (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, borderLeft: '2px solid var(--border)' }}>
          {rows.map((h) => (
            <HistoryItem key={h.id} h={h} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function HistoryItem({ h }: { h: HistoryRow }) {
  const F = useFmt();
  const L = useAssetLabels();
  const T = useT(TEXT);
  const lines: [string, string][] = [];
  const stateChanged = h.to_state !== null && (h.from_state !== h.to_state || h.from_substate !== h.to_substate);
  if (stateChanged) {
    const from = h.from_state ? stateText(L, h.from_state, h.from_substate) : null;
    lines.push([T.state, from ? `${from} → ${stateText(L, h.to_state as string, h.to_substate)}` : stateText(L, h.to_state as string, h.to_substate)]);
  }
  if (h.from_holder_name !== h.to_holder_name) lines.push([T.holder, `${h.from_holder_name ?? T.none} → ${h.to_holder_name ?? T.none}`]);
  if (h.from_department_name !== h.to_department_name) {
    lines.push([T.dept, h.from_department_name ? `${h.from_department_name} → ${h.to_department_name ?? T.none}` : (h.to_department_name ?? T.none)]);
  }
  if (h.from_location !== h.to_location) lines.push([T.location, `${h.from_location ?? T.none} → ${h.to_location ?? T.none}`]);
  if (h.note) {
    const changed = h.type === 'UPDATE' ? changedFields(h.note, T.field) : null;
    if (changed !== null) lines.push([T.changed, changed]);
    else lines.push([T.note, h.note]);
  }

  return (
    <li style={{ position: 'relative', padding: '0 0 14px 16px' }}>
      <span aria-hidden style={{ position: 'absolute', left: -6, top: 5, width: 10, height: 10, borderRadius: 5, background: 'var(--accent-blue)' }} />
      <div style={{ fontSize: 14 }}>
        <strong>{L.txn[h.type] ?? h.type}</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {' · '}
          <time dateTime={h.created_at}>{F.dateTime(h.created_at)}</time>
          {' · '}
          {T.by(h.actor_name ?? T.unknownActor)}
        </span>
      </div>
      {lines.length > 0 ? (
        <dl style={{ margin: '4px 0 0', display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 10px', fontSize: 13 }}>
          {lines.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
              <dd style={{ margin: 0 }}>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}
