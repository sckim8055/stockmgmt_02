'use client';
import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { LangSwitcher } from '../i18n/switcher';
import { button, card, ErrorText, Field, input, postJson } from '../ui';
import { TEXT } from './page.text';

export default function LoginPage() {
  const T = useT(TEXT);
  const [companyCode, setCompanyCode] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const r = await postJson<{ user: { mustChangePassword: boolean } }>('/api/auth/login', { companyCode, loginId, password });
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? T.failed);
      return;
    }
    window.location.href = r.data.user.mustChangePassword ? '/change-password' : '/';
  }

  return (
    <main style={card}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <LangSwitcher />
      </div>
      <h1 style={{ fontSize: 20, marginTop: 0 }}>{T.title}</h1>
      <form onSubmit={submit}>
        <Field label={T.companyCode}>
          <input style={input} value={companyCode} onChange={(e) => setCompanyCode(e.target.value)} autoComplete="organization" required />
        </Field>
        <Field label={T.loginId}>
          <input style={input} value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" required />
        </Field>
        <Field label={T.password}>
          <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <ErrorText>{error}</ErrorText>
        <button style={button} disabled={busy}>{busy ? T.checking : T.submit}</button>
      </form>
    </main>
  );
}
