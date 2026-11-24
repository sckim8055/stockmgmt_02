'use client';
import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { LangSwitcher } from '../i18n/switcher';
import { authButtonClass, authCardClass, authInputClass, ErrorText, Field, postJson } from '../ui';
import { TEXT } from './page.text';
import { TEXT as SHELL_TEXT } from '../shell.text';

export default function LoginPage() {
  const T = useT(TEXT);
  const S = useT(SHELL_TEXT);
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
    <main className={authCardClass}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <span className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">{S.product}</span>
        </span>
        <LangSwitcher />
      </div>
      <h1>{T.title}</h1>
      <form onSubmit={submit}>
        <Field label={T.companyCode}>
          <input className={authInputClass} value={companyCode} onChange={(e) => setCompanyCode(e.target.value)} autoComplete="organization" required />
        </Field>
        <Field label={T.loginId}>
          <input className={authInputClass} value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" required />
        </Field>
        <Field label={T.password}>
          <input className={authInputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <ErrorText>{error}</ErrorText>
        <button className={authButtonClass} disabled={busy}>{busy ? T.checking : T.submit}</button>
      </form>
    </main>
  );
}
