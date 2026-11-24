'use client';
import { RequireCompany, useShell } from '../../shell';
import { Notice, PageHeader } from '../../ui';
import { ImportCard } from './import-card';
import { IMPORT_KINDS, KIND_INFO } from './labels';
import { useT } from '../../i18n';
import { TEXT } from './page.text';

export default function ImportPage() {
  return (
    <RequireCompany>
      <ImportInner />
    </RequireCompany>
  );
}

function ImportInner() {
  const T = useT(TEXT);
  const { can } = useShell();
  const kinds = IMPORT_KINDS.filter((k) => can(...KIND_INFO[k].permission));
  return (
    <div>
      <PageHeader title={T.title} />
      <section aria-label={T.rulesTitle} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{T.rulesTitle}</div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          {T.rules.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </section>
      {kinds.length === 0 ? <Notice>{T.noPermission}</Notice> : null}
      <div style={{ display: 'grid', gap: 14 }}>
        {kinds.map((k) => <ImportCard key={k} kind={k} />)}
      </div>
    </div>
  );
}
