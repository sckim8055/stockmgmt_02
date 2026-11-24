'use client';
import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { LangSwitcher } from '../i18n/switcher';
import { authButtonClass, authCardClass, authInputClass, ErrorText, Field, postJson } from '../ui';
import { TEXT } from './page.text';
import { TEXT as SHELL_TEXT } from '../shell.text';

export default function ChangePasswordPage() {
  const T = useT(TEXT);
  const S = useT(SHELL_TEXT);
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) {
      setError(T.mismatch);
      return;
    }
    setBusy(true);
    setError('');
    const r = await postJson<{ ok: true }>('/api/auth/change-password', { currentPassword, newPassword });
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? T.failed);
      return;
    }
    window.location.href = '/';
  }

  return (
    <main className={authCardClass}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <span className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">{S.product}</span>
        </span>
        <LangSwitcher />
      </div>
      <h1>{T.title}</h1>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{T.rule}</p>
      <form onSubmit={submit}>
        <Field label={T.current}>
          <input className={authInputClass} type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label={T.next}>
          <input className={authInputClass} type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label={T.confirm}>
          <input className={authInputClass} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        <ErrorText>{error}</ErrorText>
        <button className={authButtonClass} disabled={busy}>{busy ? T.changing : T.submit}</button>
      </form>
    </main>
  );
}
