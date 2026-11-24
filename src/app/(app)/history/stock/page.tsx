'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import { api, Badge, Button, EmptyRow, ErrorText, PageHeader, smallInput, Table, td } from '../../../ui';
import { useAssetLabels } from '../../assets/labels';
import { PersonPicker, useDebounced, type PersonRef } from '../../assets/shared';
import { FilterBox, filterSelect, Pager } from '../../peripherals/shared';
import { HISTORY_KINDS, useHistoryLabels, type HistoryKind, type HistoryPage, type StockHistoryItem } from '../labels';
import { changedFields } from '../../assets/[id]/history';
import { TEXT as ASSET_HISTORY_TEXT } from '../../assets/[id]/history.text';
import { DateRangeFilter, RangeHint, readRange, useUrlFilters } from '../shared';
import { useT } from '../../../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../../../i18n/format';

const PAGE_SIZE = 50;
const PATH = '/history/stock';

/** URL 에서 읽어 API 로 그대로 넘기는 조건. personName 은 화면 표시용이라 넘기지 않는다. */
const API_KEYS = ['kind', 'type', 'personId', 'q', 'page'] as const;

export default function StockHistoryPage() {
  const T = useT(TEXT);
  return (
    <RequireCompany>
      {/* useSearchParams 는 Suspense 경계 안에서 써야 한다(Next.js 빌드 규칙). */}
      <Suspense fallback={<p style={{ color: 'var(--text-muted)' }}>{T.loading}</p>}>
        <StockHistoryInner />
      </Suspense>
    </RequireCompany>
  );
}

const arrow = (from: string | null, to: string | null, none: string) => {
  if (from === null && to === null) return '';
  if (from === to) return from ?? '';
  if (from === null) return to ?? '';
  return `${from} → ${to ?? none}`;
};

function StockHistoryInner() {
  const F = useFmt();
  const AH = useT(ASSET_HISTORY_TEXT);
  const AL = useAssetLabels();
  const HL = useHistoryLabels();
  const T = useT(TEXT);
  const { can } = useShell();
  const { spKey, get, setParams, reset } = useUrlFilters(PATH);
  const [data, setData] = useState<HistoryPage<StockHistoryItem> | null>(null);
  const [loadError, setLoadError] = useState('');
  const [qInput, setQInput] = useState(get('q'));
  const dq = useDebounced(qInput.trim(), 350);

  const kind: HistoryKind | '' = (HISTORY_KINDS as string[]).includes(get('kind')) ? (get('kind') as HistoryKind) : '';
  const types = HL.typeOptions(kind);
  const range = readRange(get);
  const person: PersonRef | null = get('personId') ? { id: get('personId'), name: get('personName') || get('personId') } : null;

  useEffect(() => {
    if (dq !== (new URLSearchParams(spKey).get('q') ?? '')) setParams({ q: dq || null });
  }, [dq]);

  useEffect(() => {
    if (range.invalid) {
      setData(null);
      setLoadError('');
      return;
    }
    const from = new URLSearchParams(spKey);
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    for (const k of API_KEYS) {
      const v = from.get(k);
      if (v) params.set(k, v);
    }
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    let live = true;
    void (async () => {
      const r = await api<HistoryPage<StockHistoryItem>>('GET', `/api/history/stock?${params.toString()}`);
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setLoadError('');
      } else if (!r.redirected) {
        setData(null);
        setLoadError(r.error.message);
      }
    })();
    return () => {
      live = false;
    };
  }, [spKey]);

  const canAsset = can('asset.item', 'read');
  const head = [T.colTime, T.colKind, T.colType, T.colTarget, T.colDept, T.colQty, T.colPerson, T.colState, T.colLocation, T.colNote, T.colActor];
  const items = data?.items ?? [];
  const stateName = (s: string | null) => (s === null ? null : (AL.state as Record<string, string>)[s] ?? s);
  // 자산 수정 이력의 메모("changed: a, b")는 자산 상세 화면과 같이 바뀐 항목 이름으로 보여 준다.
  const noteText = (h: StockHistoryItem) => (h.note && h.kind === 'ASSET' && h.type === 'UPDATE' ? changedFields(h.note, AH.field) ?? h.note : h.note ?? '');

  return (
    <div>
      <PageHeader title={T.title} />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 6, fontSize: 14, flexWrap: 'wrap' }}>
        <FilterBox label={T.filterKind}>
          {(id) => (
            <select
              id={id}
              value={kind}
              onChange={(e) => {
                const next = e.target.value as HistoryKind | '';
                // 새 구분에 없는 종류는 지운다.
                const keepType = HL.typeOptions(next).some((o) => o.value === get('type'));
                setParams({ kind: next || null, type: keepType ? get('type') : null });
              }}
              style={filterSelect}
            >
              <option value="">{T.all}</option>
              {HISTORY_KINDS.map((k) => <option key={k} value={k}>{HL.kind[k]}</option>)}
            </select>
          )}
        </FilterBox>
        <FilterBox label={T.filterType}>
          {(id) => (
            <select id={id} value={types.some((o) => o.value === get('type')) ? get('type') : ''} onChange={(e) => setParams({ type: e.target.value || null })} style={filterSelect}>
              <option value="">{T.all}</option>
              {types.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </FilterBox>
        {can('master.person', 'read') ? (
          <FilterBox label={T.filterPerson} width={220}>
            {(id) => <PersonPicker id={id} value={person} onChange={(p) => setParams({ personId: p?.id ?? null, personName: p?.name ?? null })} />}
          </FilterBox>
        ) : null}
        <FilterBox label={T.filterQ}>
          {(id) => (
            <input id={id} type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={T.filterQPlaceholder} maxLength={100} style={{ ...smallInput, width: 220, margin: 0 }} />
          )}
        </FilterBox>
        <DateRangeFilter from={range.from} to={range.to} onChange={(patch) => setParams(patch)} />
        {spKey ? (
          <div style={{ paddingBottom: 4 }}>
            <Button small variant="link" onClick={() => { setQInput(''); reset(); }}>{T.reset}</Button>
          </div>
        ) : null}
      </div>
      <RangeHint invalid={range.invalid} />

      <ErrorText>{loadError}</ErrorText>
      {data === null && !loadError && !range.invalid ? <p style={{ color: 'var(--text-muted)' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 6px' }}>{T.qtyHint}</p>
          <Table head={head}>
            {items.length === 0 ? <EmptyRow colSpan={head.length}>{T.empty}</EmptyRow> : null}
            {items.map((h) => (
              <tr key={`${h.kind}:${h.id}`}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}><time dateTime={h.created_at}>{F.dateTime(h.created_at)}</time></td>
                <td style={td}><Badge tone={h.kind === 'ASSET' ? 'blue' : 'amber'}>{HL.kind[h.kind] ?? h.kind}</Badge></td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{HL.typeLabel(h.kind, h.type)}</td>
                <td style={td}>
                  {h.kind === 'ASSET' ? (
                    <>
                      {canAsset && h.ref_label ? <Link href={`/assets/${encodeURIComponent(h.ref_id)}`}>{h.ref_label}</Link> : h.ref_label}
                      <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{`${h.manufacturer} ${h.model_name}`}</div>
                    </>
                  ) : (
                    `${h.manufacturer} ${h.model_name}`
                  )}
                </td>
                <td style={td}>{h.department_name}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: h.qty !== null && h.qty < 0 ? 'var(--danger-text)' : 'var(--success-text)' }}>
                  {h.kind === 'PERIPHERAL' && h.qty !== null ? F.signed(h.qty) : ''}
                </td>
                <td style={td}>{arrow(h.from_person, h.to_person, T.none)}</td>
                <td style={td}>{arrow(stateName(h.from_state), stateName(h.to_state), T.none)}</td>
                <td style={td}>{h.location ?? ''}</td>
                <td style={td}>{noteText(h)}</td>
                <td style={td}>{h.actor_name ?? T.unknownActor}</td>
              </tr>
            ))}
          </Table>
          <Pager page={data.page} pageSize={data.pageSize} hasNext={data.hasMore} onPage={(p) => setParams({ page: String(p) }, true)} />
          {data.filtered && data.scanWindow ? <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>{T.windowHint(F.num(data.scanWindow))}</p> : null}
        </>
      ) : null}
    </div>
  );
}
