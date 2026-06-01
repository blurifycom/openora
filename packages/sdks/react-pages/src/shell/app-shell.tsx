'use client';

import type { ReactNode } from 'react';
import { Link, useCurrentUser, useLogout, useNavigate, usePathname, useUI } from '@oss/react-hooks';
import { useNavItems } from '../ui-plugin/registry.js';
import type { AppShellNavItem } from '../ui-plugin/context.js';
import {
  DashboardIcon,
  GamesIcon,
  LogoutIcon,
  PlayersIcon,
  UsersIcon,
} from '@oss/react-blocks/admin';

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
  brand = 'OSS Igaming',
  nav,
  loginPath = '/login',
}: {
  children: ReactNode;
  brand?: string;
  nav?: AppShellNavItem[];
  loginPath?: string;
}) {
  const pathname = usePathname();
  const navigate = useNavigate();
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
    navigate.replace(loginPath);
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
