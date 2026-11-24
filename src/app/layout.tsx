import type { ReactNode } from 'react';

export const metadata = { title: 'StockMgmt', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#f5f6f8', color: '#1c1f23' }}>
        {children}
      </body>
    </html>
  );
}
