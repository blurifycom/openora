'use client';

import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useUI } from '../ui-provider.js';
import { useCurrentUser } from '../hooks/user.js';
import { useLogout } from '../hooks/auth.js';
import { useNavItems } from '../ui-plugin/registry.js';
import type { AppShellNavItem } from '../ui-plugin/context.js';
import { DashboardIcon, GamesIcon, LogoutIcon, PlayersIcon, UsersIcon } from './icons';

export type { AppShellNavItem };

const DEFAULT_NAV: AppShellNavItem[] = [
  { href: '/', label: 'Dashboard', icon: DashboardIcon },
  { href: '/players', label: 'Players', icon: PlayersIcon },
  { href: '/users', label: 'Users', icon: UsersIcon },
  { href: '/games', label: 'Games', icon: GamesIcon },
];

type CurrentUser = { email?: string; name?: string | null } | null | undefined;

/**
 * Sidebar + topbar layout. Consumer's explicit `nav` overrides the default.
 * Plugin-registered nav items (via `defineUIPlugin({ register(ctx) { ctx.nav.add(...) } })`)
 * are appended after the explicit/default nav.
 */
export function AppShell({
  children,
  brand = 'OSS Casino',
  nav,
  loginPath = '/login',
}: {
  children: ReactNode;
  brand?: string;
  nav?: AppShellNavItem[];
  loginPath?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { Button } = useUI();
  const { data: user } = useCurrentUser() as { data: CurrentUser };
  const logout = useLogout();
  const pluginNav = useNavItems();

  const baseNav = nav ?? DEFAULT_NAV;
  const items: AppShellNavItem[] = [...baseNav, ...pluginNav];

  // Only one nav item is active: the one whose href is the longest prefix of
  // the current path. This stops an index route (eg `/admin`) from staying lit
  // on every nested route, since a deeper match (`/admin/users`) wins.
  const matches = (href: string): boolean => pathname === href || pathname.startsWith(`${href}/`);
  const activeHref = items
    .map((item) => item.href)
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0];

  const onLogout = async (): Promise<void> => {
    await logout.mutateAsync(undefined as never).catch(() => undefined);
    router.replace(loginPath);
  };

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">{brand}</div>
        <nav className="app-shell__nav">
          {items.map((item) => {
            const active = item.href === activeHref;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`app-shell__nav-link${active ? ' app-shell__nav-link--active' : ''}`}
              >
                {Icon ? <Icon /> : null}
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="app-shell__main">
        <header className="app-shell__topbar">
          <div className="app-shell__user">{user?.email ?? 'Connecting...'}</div>
          <Button variant="ghost" size="sm" onClick={onLogout} loading={logout.isPending}>
            <LogoutIcon />
            Sign out
          </Button>
        </header>
        <main className="app-shell__content">{children}</main>
      </div>
    </div>
  );
}
