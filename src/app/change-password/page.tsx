'use client';
import { useState, type FormEvent } from 'react';
import { button, card, ErrorText, Field, input, postJson } from '../ui';

export default function ChangePasswordPage() {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) {
      setError('새 비밀번호가 서로 다릅니다.');
      return;
    }
    setBusy(true);
    setError('');
    const { ok, data } = await postJson('/api/auth/change-password', { currentPassword, newPassword });
    setBusy(false);
    if (!ok) {
      setError(data?.error?.message ?? '변경에 실패했습니다.');
      return;
    }
    window.location.href = '/';
  }

  return (
    <main style={card}>
      <h1 style={{ fontSize: 20, marginTop: 0 }}>비밀번호 변경</h1>
      <p style={{ fontSize: 13, color: '#4b5563' }}>10자 이상, 영문 대·소문자·숫자·기호 중 3가지 이상을 섞어야 합니다.</p>
      <form onSubmit={submit}>
        <Field label="현재(임시) 비밀번호">
          <input style={input} type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="새 비밀번호">
          <input style={input} type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="새 비밀번호 확인">
          <input style={input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        <ErrorText>{error}</ErrorText>
        <button style={button} disabled={busy}>{busy ? '변경 중…' : '변경'}</button>
      </form>
    </main>
  );
}
