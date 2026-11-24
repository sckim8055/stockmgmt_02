import type { ReactNode } from 'react';
import { LangProvider } from './i18n';

export const metadata = { title: 'StockMgmt', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#f5f6f8', color: '#1c1f23' }}>
        {/* 화면 언어. 첫 렌더는 한국어이고, 브라우저에서 고른 언어·사용자 언어로 바꾸면서 <html lang> 도 맞춘다. */}
        <LangProvider>{children}</LangProvider>
      </body>
    </html>
  );
}
