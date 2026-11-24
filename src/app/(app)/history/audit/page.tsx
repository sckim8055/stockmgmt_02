'use client';
import { Fragment, Suspense, useEffect, useState } from 'react';
import { RequireCompany, useShell } from '../../../shell';
import { api, Button, EmptyRow, ErrorText, Notice, PageHeader, smallInput, Table, td } from '../../../ui';
import { useDebounced } from '../../assets/shared';
import { FilterBox, filterSelect, Pager } from '../../peripherals/shared';
import { useResourceLabels } from '../../admin/resource-labels';
import { ACTION_PREFIX_RE, useHistoryLabels, type AuditItem, type HistoryPage } from '../labels';
import { DateRangeFilter, RangeHint, readRange, useUrlFilters } from '../shared';
import { useT } from '../../../i18n';
import { TEXT } from './page.text';
import { useFmt } from '../../../i18n/format';

const PAGE_SIZE = 50;
const PATH = '/history/audit';

/** URL 에서 읽어 API 로 그대로 넘기는 조건 */
const API_KEYS = ['resource', 'actorId', 'targetId', 'page'] as const;

interface AccountOption {
  id: string;
  login_id: string;
  display_name: string;
}

export default function AuditPage() {
  const T = useT(TEXT);
  return (
    <RequireCompany>
      <Suspense fallback={<p style={{ color: '#6b7280' }}>{T.loading}</p>}>
        <AuditInner />
      </Suspense>
    </RequireCompany>
  );
}

function AuditInner() {
  const F = useFmt();
  const RL = useResourceLabels();
  const HL = useHistoryLabels();
  const T = useT(TEXT);
  const { can } = useShell();
  const { spKey, get, setParams, reset } = useUrlFilters(PATH);
  const [data, setData] = useState<HistoryPage<AuditItem> | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [actionInput, setActionInput] = useState(get('action'));
  const typed = actionInput.trim().toUpperCase();
  const actionInvalid = typed !== '' && !ACTION_PREFIX_RE.test(typed);
  const dAction = useDebounced(typed, 350);

  const range = readRange(get);
  const urlAction = ACTION_PREFIX_RE.test(get('action')) ? get('action') : '';
  const canAccounts = can('admin.user', 'read');

  useEffect(() => {
    // 형식이 맞을 때만 URL(= 서버 조회 조건)에 넣는다.
    if (dAction !== '' && !ACTION_PREFIX_RE.test(dAction)) return;
    if (dAction !== urlAction) setParams({ action: dAction || null });
  }, [dAction]);

  useEffect(() => {
    if (!canAccounts) return;
    let live = true;
    void (async () => {
      const r = await api<{ users: AccountOption[] }>('GET', '/api/admin/users');
      if (live && r.ok) setAccounts(r.data.users);
    })();
    return () => {
      live = false;
    };
  }, [canAccounts]);

  useEffect(() => {
    if (range.invalid) {
      setData(null);
      setLoadError(null);
      return;
    }
    const from = new URLSearchParams(spKey);
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    for (const k of API_KEYS) {
      const v = from.get(k);
      if (v) params.set(k, v);
    }
    if (urlAction) params.set('action', urlAction);
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    let live = true;
    void (async () => {
      const r = await api<HistoryPage<AuditItem>>('GET', `/api/history/audit?${params.toString()}`);
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setLoadError(null);
        setOpen(new Set());
      } else if (!r.redirected) {
        setData(null);
        setLoadError({ status: r.status, message: r.error.message });
      }
    })();
    return () => {
      live = false;
    };
  }, [spKey]);

  // 부서 범위가 제한된 사용자 등 서버가 거부한 경우: 서버의 안내를 그대로 보여 주고 조건은 감춘다.
  if (loadError?.status === 403) {
    return (
      <div>
        <PageHeader title={T.title} />
        <Notice>{loadError.message}</Notice>
      </div>
    );
  }

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const head = [T.colTime, T.colAction, T.colResource, T.colTarget, T.colActor, T.colIp, T.colDetail];
  const items = data?.items ?? [];
  const resourceValue = get('resource');

  return (
    <div>
      <PageHeader title={T.title} />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 6, fontSize: 14, flexWrap: 'wrap' }}>
        <FilterBox label={T.filterAction}>
          {(id) => (
            <input
              id={id}
              value={actionInput}
              onChange={(e) => setActionInput(e.target.value)}
              placeholder={T.filterActionPlaceholder}
              title={T.filterActionHint}
              maxLength={60}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={actionInvalid || undefined}
              style={{ ...smallInput, width: 190, margin: 0, fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }}
            />
          )}
        </FilterBox>
        <FilterBox label={T.filterResource}>
          {(id) => (
            <select id={id} value={resourceValue} onChange={(e) => setParams({ resource: e.target.value || null })} style={filterSelect}>
              <option value="">{T.all}</option>
              {RL.auditCodes.map((c) => <option key={c} value={c}>{`${RL.auditLabel(c)} (${c})`}</option>)}
              {resourceValue && !RL.auditCodes.includes(resourceValue) ? <option value={resourceValue}>{resourceValue}</option> : null}
            </select>
          )}
        </FilterBox>
        {canAccounts ? (
          <FilterBox label={T.filterActor}>
            {(id) => (
              <select id={id} value={get('actorId')} onChange={(e) => setParams({ actorId: e.target.value || null })} style={filterSelect}>
                <option value="">{T.all}</option>
                {accounts.map((u) => <option key={u.id} value={u.id}>{`${u.display_name} (${u.login_id})`}</option>)}
              </select>
            )}
          </FilterBox>
        ) : null}
        <DateRangeFilter from={range.from} to={range.to} onChange={(patch) => setParams(patch)} />
        {spKey ? (
          <div style={{ paddingBottom: 4 }}>
            <Button small variant="link" onClick={() => { setActionInput(''); reset(); }}>{T.reset}</Button>
          </div>
        ) : null}
      </div>
      {actionInvalid ? <p role="alert" style={{ fontSize: 12, color: '#b91c1c', margin: '0 0 4px' }}>{T.actionInvalid}</p> : null}
      <RangeHint invalid={range.invalid} />

      <ErrorText>{loadError?.message}</ErrorText>
      {data === null && !loadError && !range.invalid ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {data ? (
        <>
          <Table head={head}>
            {items.length === 0 ? <EmptyRow colSpan={head.length}>{T.empty}</EmptyRow> : null}
            {items.map((a) => {
              const hasDetail = a.before != null || a.after != null;
              const expanded = open.has(a.id);
              const detailId = `audit-detail-${a.id}`;
              return (
                <Fragment key={a.id}>
                  <tr>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}><time dateTime={a.created_at}>{F.dateTime(a.created_at)}</time></td>
                    <td style={td}>
                      {HL.action[a.action] ?? a.action}
                      {HL.action[a.action] ? <div style={{ color: '#6b7280', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>{a.action}</div> : null}
                    </td>
                    <td style={td}>
                      {RL.auditLabel(a.resource)}
                      <div style={{ color: '#6b7280', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>{a.resource}</div>
                    </td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all' }}>{a.target_id ?? ''}</td>
                    <td style={td}>
                      {a.actor_id === null ? T.systemActor : a.actor_name === null ? T.outsideActor : a.actor_name}
                      {a.actor_login ? <div style={{ color: '#6b7280', fontSize: 12 }}>{a.actor_login}</div> : null}
                    </td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{a.ip ?? ''}</td>
                    <td style={td}>
                      {hasDetail ? (
                        <Button small variant="link" aria-expanded={expanded} aria-controls={detailId} onClick={() => toggle(a.id)}>
                          {expanded ? T.hide : T.show}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                  {hasDetail && expanded ? (
                    <tr id={detailId}>
                      <td colSpan={head.length} style={{ ...td, background: '#f7f8fa' }}>
                        <div role="region" aria-label={T.detailLabel(a.action)} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                          <JsonBlock title={T.before} value={a.before} empty={T.noValue} />
                          <JsonBlock title={T.after} value={a.after} empty={T.noValue} />
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </Table>
          <Pager page={data.page} pageSize={data.pageSize} hasNext={data.hasMore} onPage={(p) => setParams({ page: String(p) }, true)} />
        </>
      ) : null}
    </div>
  );
}

/** JSON 을 글자 그대로 보여 준다(React 텍스트 노드라 HTML 로 해석되지 않는다). */
function JsonBlock({ title, value, empty }: { title: string; value: unknown; empty: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#4b5563', marginBottom: 4 }}>{title}</div>
      <pre style={{ margin: 0, padding: '8px 10px', background: '#fff', border: '1px solid #e2e5ea', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto' }}>
        {value == null ? empty : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
