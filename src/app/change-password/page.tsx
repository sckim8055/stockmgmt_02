'use client';
import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { LangSwitcher } from '../i18n/switcher';
import { button, card, ErrorText, Field, input, postJson } from '../ui';
import { TEXT } from './page.text';

export default function ChangePasswordPage() {
  const T = useT(TEXT);
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
    <main style={card}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <LangSwitcher />
      </div>
      <h1 style={{ fontSize: 20, marginTop: 0 }}>{T.title}</h1>
      <p style={{ fontSize: 13, color: '#4b5563' }}>{T.rule}</p>
      <form onSubmit={submit}>
        <Field label={T.current}>
          <input style={input} type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label={T.next}>
          <input style={input} type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label={T.confirm}>
          <input style={input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        <ErrorText>{error}</ErrorText>
        <button style={button} disabled={busy}>{busy ? T.changing : T.submit}</button>
      </form>
    </main>
  );
}
