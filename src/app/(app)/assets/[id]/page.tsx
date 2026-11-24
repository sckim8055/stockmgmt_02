'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ACTION_RESOURCE, type AssetAction } from '@/lib/assets/transitions';
import { RequireCompany, useShell } from '../../../shell';
import { api, Badge, Button, ErrorText, Notice } from '../../../ui';
import { allowedActions, DESTRUCTIVE } from '../actions';
import { ACTION_LABEL } from '../labels';
import { customDisplay, fmtDateTime, fmtPrice, isOverdue, listOf, modelLabel, StateBadge, useList } from '../shared';
import type { AssetRow, CustomFieldDef } from '../types';
import { ActionDialog } from './action-dialog';
import { EditAssetDialog } from './edit-dialog';
import { AssetHistory } from './history';

const T = {
  back: '← 자산 목록',
  loading: '불러오는 중…',
  notFound: '자산을 찾을 수 없습니다.',
  notFoundHint: '삭제되었거나, 다른 기업 또는 볼 수 없는 부서의 자산일 수 있습니다.',
  edit: '수정',
  actions: '처리',
  saved: '저장했습니다.',
  done: (a: string) => `${a} 처리했습니다.`,
  conflict: (m: string) => `${m} 최신 상태를 다시 불러왔습니다.`,
  secBasic: '기본 정보',
  secHolding: '보유/위치',
  secPurchase: '구매 정보',
  secCustom: '사용자 지정 필드',
  tag: '자산 태그',
  model: '모델',
  category: '카테고리',
  serial: '시리얼',
  state: '상태',
  warranty: '보증 만료일',
  createdAt: '등록일',
  updatedAt: '최종 수정',
  holder: '보유자',
  dept: '관리 부서',
  location: '위치',
  due: '반납 기한',
  overdue: '기한 지남',
  purchaseDate: '구매일',
  price: '구매가',
  supplier: '공급업체',
  customNone: '입력된 값이 없습니다.',
};

type Load = { kind: 'loading' } | { kind: 'notfound' } | { kind: 'error'; message: string } | { kind: 'ready'; asset: AssetRow };

export default function AssetDetailPage() {
  const params = useParams<{ id: string }>();
  return (
    <RequireCompany>
      <AssetDetail key={params.id} assetId={params.id} />
    </RequireCompany>
  );
}

function AssetDetail({ assetId }: { assetId: string }) {
  const { can } = useShell();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [historyKey, setHistoryKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [acting, setActing] = useState<AssetAction | null>(null);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');
  const fields = useList<CustomFieldDef>(can('master.custom_field', 'read') ? '/api/master/custom-fields' : null, 'fields');

  const load = useCallback(async () => {
    const r = await api<{ asset: AssetRow }>('GET', `/api/assets/${encodeURIComponent(assetId)}`);
    if (r.ok) setState({ kind: 'ready', asset: r.data.asset });
    else if (r.redirected) return;
    else if (r.status === 404) setState({ kind: 'notfound' });
    else setState({ kind: 'error', message: r.error.message });
    setHistoryKey((k) => k + 1);
  }, [assetId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') return <p style={{ color: '#6b7280' }}>{T.loading}</p>;
  if (state.kind === 'notfound') {
    return (
      <div>
        <Notice>
          <strong>{T.notFound}</strong> {T.notFoundHint}
        </Notice>
        <Link href="/assets">{T.back}</Link>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div>
        <ErrorText>{state.message}</ErrorText>
        <Link href="/assets">{T.back}</Link>
      </div>
    );
  }

  const a = state.asset;
  const actions = allowedActions({ state: a.state, substate: a.substate, holderPersonId: a.holder_person_id })
    .filter((x) => can(ACTION_RESOURCE[x], 'execute'));
  const canEdit = can('asset.item', 'update') && a.state !== 'VOID';
  const reset = () => {
    setNotice('');
    setProblem('');
  };

  const defs = listOf(fields);
  const customEntries = Object.entries(a.custom).sort(([x], [y]) => {
    const dx = defs.find((d) => d.key === x)?.sort_order ?? 0;
    const dy = defs.find((d) => d.key === y)?.sort_order ?? 0;
    return dx - dy || x.localeCompare(y);
  });

  return (
    <div>
      <Link href="/assets" style={{ fontSize: 14 }}>{T.back}</Link>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '10px 0 14px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>{a.asset_tag}</h1>
        <span style={{ color: '#4b5563' }}>{modelLabel({ manufacturer: a.manufacturer, name: a.model_name })}</span>
        <StateBadge state={a.state} substate={a.substate} />
        {canEdit ? (
          <div style={{ marginLeft: 'auto' }}>
            <Button onClick={() => { reset(); setEditing(true); }}>{T.edit}</Button>
          </div>
        ) : null}
      </div>

      {actions.length > 0 ? (
        <div role="group" aria-label={T.actions} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {actions.map((x) => (
            <Button key={x} small variant={DESTRUCTIVE.has(x) ? 'danger' : 'secondary'} onClick={() => { reset(); setActing(x); }}>
              {ACTION_LABEL[x]}
            </Button>
          ))}
        </div>
      ) : null}

      {notice ? <p role="status" style={{ color: '#166534', fontSize: 14 }}>{notice}</p> : null}
      <ErrorText>{problem}</ErrorText>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        <Section title={T.secBasic}>
          <Info label={T.tag}>{a.asset_tag}</Info>
          <Info label={T.model}>{modelLabel({ manufacturer: a.manufacturer, name: a.model_name })}</Info>
          <Info label={T.category}>{a.category_name}</Info>
          <Info label={T.serial}>{a.serial_number}</Info>
          <Info label={T.state}><StateBadge state={a.state} substate={a.substate} /></Info>
          <Info label={T.warranty}>{a.warranty_end}</Info>
          <Info label={T.createdAt}>{fmtDateTime(a.created_at)}</Info>
          <Info label={T.updatedAt}>{fmtDateTime(a.updated_at)}</Info>
        </Section>
        <Section title={T.secHolding}>
          <Info label={T.holder}>
            {a.holder_name ? (
              <>
                {a.holder_name}
                {a.holder_employee_no ? <span style={{ color: '#6b7280' }}> ({a.holder_employee_no})</span> : null}
              </>
            ) : null}
          </Info>
          <Info label={T.dept}>{a.department_name}</Info>
          <Info label={T.location}>{a.location}</Info>
          <Info label={T.due}>
            {a.due_date ? (
              <>
                {a.due_date}
                {a.state === 'IN_USE' && isOverdue(a.due_date) ? <> <Badge tone="red">{T.overdue}</Badge></> : null}
              </>
            ) : null}
          </Info>
        </Section>
        <Section title={T.secPurchase}>
          <Info label={T.purchaseDate}>{a.purchase_date}</Info>
          {/* 권한이 없으면 서버가 키 자체를 뺀다. 키가 있을 때만 그린다. */}
          {'purchase_price' in a ? <Info label={T.price}>{fmtPrice(a.purchase_price)}</Info> : null}
          {'supplier' in a ? <Info label={T.supplier}>{a.supplier}</Info> : null}
        </Section>
        <Section title={T.secCustom}>
          {customEntries.length === 0 ? <div style={{ gridColumn: '1 / -1', color: '#6b7280' }}>{T.customNone}</div> : null}
          {customEntries.map(([k, v]) => (
            <Info key={k} label={defs.find((d) => d.key === k)?.label ?? k}>{customDisplay(v)}</Info>
          ))}
        </Section>
      </div>

      {can('history.stock', 'read') ? <AssetHistory assetId={a.id} reloadKey={historyKey} /> : null}

      {editing ? (
        <EditAssetDialog
          asset={a}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setNotice(T.saved);
            void load();
          }}
          onGone={(m) => {
            setEditing(false);
            setProblem(T.conflict(m));
            void load();
          }}
        />
      ) : null}
      {acting ? (
        <ActionDialog
          key={acting}
          asset={a}
          action={acting}
          onClose={() => setActing(null)}
          onDone={() => {
            setNotice(T.done(ACTION_LABEL[acting]));
            setActing(null);
            void load();
          }}
          onConflict={(m) => {
            setActing(null);
            setProblem(T.conflict(m));
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ background: '#fff', border: '1px solid #e2e5ea', borderRadius: 8, padding: '12px 14px' }}>
      <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>{title}</h2>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 14px', fontSize: 14 }}>{children}</dl>
    </section>
  );
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'contents' }}>
      <dt style={{ color: '#6b7280' }}>{label}</dt>
      <dd style={{ margin: 0 }}>{children ?? '-'}</dd>
    </div>
  );
}
