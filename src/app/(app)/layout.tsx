import type { ReactNode } from 'react';
import { AppShell } from '../shell';

// 로그인한 화면의 공통 틀. /login, /change-password 는 이 그룹 밖에 있어 틀을 쓰지 않는다.
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
