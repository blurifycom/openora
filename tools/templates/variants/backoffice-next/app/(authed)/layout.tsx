import type { ReactNode } from 'react';
import { AppShell, AuthGuard } from '@oss/react-sdk';

// Admin pages render live data client-side (TanStack Query) behind an auth guard;
// nothing to statically prerender. Render dynamically.
export const dynamic = 'force-dynamic';

export default function AuthedLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <AppShell>{children}</AppShell>
    </AuthGuard>
  );
}
