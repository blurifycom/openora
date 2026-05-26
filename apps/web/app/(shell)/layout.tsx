import type { ReactNode } from 'react';
import { PlayerShell } from '../../components/player-shell';

// These pages render live data from the API client-side (TanStack Query); there
// is nothing to statically prerender, and the client QueryClient provider isn't
// available during static export. Render dynamically.
export const dynamic = 'force-dynamic';

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <PlayerShell>{children}</PlayerShell>;
}
