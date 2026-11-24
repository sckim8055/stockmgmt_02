'use client';
import { useState, type FormEvent } from 'react';
import { button, card, ErrorText, Field, input, postJson } from '../ui';

export default function LoginPage() {
  const [companyCode, setCompanyCode] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { ok, data } = await postJson('/api/auth/login', { companyCode, loginId, password });
    setBusy(false);
    if (!ok) {
      setError(data?.error?.message ?? '로그인에 실패했습니다.');
      return;
    }
    window.location.href = data.user.mustChangePassword ? '/change-password' : '/';
  }

  return (
    <main style={card}>
      <h1 style={{ fontSize: 20, marginTop: 0 }}>StockMgmt 로그인</h1>
      <form onSubmit={submit}>
        <Field label="기업코드">
          <input style={input} value={companyCode} onChange={(e) => setCompanyCode(e.target.value)} autoComplete="organization" required />
        </Field>
        <Field label="로그인 ID">
          <input style={input} value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" required />
        </Field>
        <Field label="비밀번호">
          <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <ErrorText>{error}</ErrorText>
        <button style={button} disabled={busy}>{busy ? '확인 중…' : '로그인'}</button>
      </form>
    </main>
  );
}
