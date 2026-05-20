import type { ReactNode } from 'react';
import { AppShell, AuthGuard } from '@oss/react-sdk';

export default function AuthedLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <AppShell>{children}</AppShell>
    </AuthGuard>
  );
}
