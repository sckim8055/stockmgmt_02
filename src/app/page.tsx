'use client';
import { useEffect, useState } from 'react';
import { button, card, postJson } from './ui';

interface Me {
  loginId: string;
  displayName: string;
  userType: string;
  mustChangePassword: boolean;
}

export default function HomePage() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch('/api/me')
      .then(async (res) => {
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        const data = await res.json();
        if (data.user.mustChangePassword) window.location.href = '/change-password';
        else setMe(data.user);
      })
      .catch(() => {
        window.location.href = '/login';
      });
  }, []);

  if (!me) return null;
  return (
    <main style={card}>
      <h1 style={{ fontSize: 20, marginTop: 0 }}>StockMgmt</h1>
      <p>
        {me.displayName} ({me.loginId}) · {me.userType}
      </p>
      <p style={{ fontSize: 13, color: '#4b5563' }}>0단계: 인증과 기업 격리까지 구현된 상태입니다. 업무 화면은 다음 단계에서 추가됩니다.</p>
      <button
        style={button}
        onClick={async () => {
          await postJson('/api/auth/logout', {});
          window.location.href = '/login';
        }}
      >
        로그아웃
      </button>
    </main>
  );
}
