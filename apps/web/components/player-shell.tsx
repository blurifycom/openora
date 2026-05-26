'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCurrentUser, useLogout, useUI } from '@oss/react-sdk';

const NAV = [
  { href: '/', label: 'Lobby' },
  { href: '/games', label: 'Games' },
  { href: '/wallet', label: 'Wallet' },
];

// App-specific player chrome. The SDK supplies page bodies, hooks, and the UI
// provider; the consumer brings its own top-nav (a real player site differs a
// lot from the admin shell).
export function PlayerShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { Button } = useUI();
  const { data: user } = useCurrentUser();
  const logout = useLogout();

  const onLogout = async (): Promise<void> => {
    await logout.mutateAsync(undefined as never).catch(() => undefined);
    router.replace('/');
  };

  return (
    <div className="player-shell">
      <header className="player-topbar">
        <div className="player-topbar__brand">OSS Igaming</div>
        <nav className="player-topbar__nav">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`player-topbar__link${active ? ' player-topbar__link--active' : ''}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="player-topbar__auth">
          {user ? (
            <>
              <span className="muted">{user.email}</span>
              <Button variant="ghost" size="sm" onClick={onLogout} loading={logout.isPending}>
                Sign out
              </Button>
            </>
          ) : (
            <Link href="/login" className="player-topbar__link">
              Sign in
            </Link>
          )}
        </div>
      </header>
      <main className="player-content">{children}</main>
    </div>
  );
}
