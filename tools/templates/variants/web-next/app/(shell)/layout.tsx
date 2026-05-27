import type { ReactNode } from 'react';
import { PlayerShell } from '../../components/player-shell';

// These pages render live data client-side (TanStack Query); nothing to statically
// prerender, and the client QueryClient provider isn't available during static export.
export const dynamic = 'force-dynamic';

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <PlayerShell>{children}</PlayerShell>;
}
