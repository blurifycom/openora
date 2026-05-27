import type { ReactNode } from 'react';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { useCurrentUser, useLogout, useUI } from '@oss/react-sdk';

const NAV = [
  { href: '/', label: 'Lobby' },
  { href: '/sportsbook', label: 'Sportsbook' },
  { href: '/wallet', label: 'Wallet' },
];

// Your player chrome. The SDK supplies page bodies, hooks, and the UI provider;
// you bring the top-nav and branding. Customize freely - this file is yours.
export function PlayerShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const router = useRouter();
  const { Button } = useUI();
  const { data: user } = useCurrentUser();
  const logout = useLogout();

  const onLogout = async (): Promise<void> => {
    await logout.mutateAsync(undefined as never).catch(() => undefined);
    await router.navigate({ to: '/' });
  };

  return (
    <div className="player-shell">
      <header className="player-topbar">
        <div className="player-topbar__brand">{{name}}</div>
        <nav className="player-topbar__nav">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                to={item.href}
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
            <Link to="/login" className="player-topbar__link">
              Sign in
            </Link>
          )}
        </div>
      </header>
      <main className="player-content">{children}</main>
    </div>
  );
}
