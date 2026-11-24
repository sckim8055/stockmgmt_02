'use client';
import type { CSSProperties, ReactNode } from 'react';

// 0단계의 임시 화면 부품. 화면 디자인은 5단계에서 기존 스타일로 교체한다.
export const card: CSSProperties = {
  maxWidth: 380, margin: '10vh auto', padding: 28, background: '#fff', borderRadius: 10,
  boxShadow: '0 1px 4px rgba(0,0,0,.12)',
};
export const input: CSSProperties = {
  width: '100%', padding: '10px 12px', margin: '6px 0 14px', border: '1px solid #c9ced6', borderRadius: 6,
  boxSizing: 'border-box', fontSize: 15,
};
export const button: CSSProperties = {
  width: '100%', padding: '11px 12px', border: 0, borderRadius: 6, background: '#2563eb', color: '#fff',
  fontSize: 15, cursor: 'pointer',
};

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 13, color: '#4b5563' }}>
      {label}
      {children}
    </label>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p role="alert" style={{ color: '#b91c1c', fontSize: 14 }}>{children}</p>;
}

export async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* 본문 없음 */
  }
  return { ok: res.ok, data };
}
