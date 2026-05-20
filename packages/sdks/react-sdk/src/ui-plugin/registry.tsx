'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { UIPlugin } from './define.js';
import { buildRegistry } from './define.js';
import { emptyRegistry, type UIRegistry } from './context.js';

const RegistryContext = createContext<UIRegistry>(emptyRegistry);

/**
 * Mount once near the top of your provider tree, above the admin shell.
 *
 * ```tsx
 * <UIPluginProvider plugins={[vipTiersUI, kycUI]}>
 *   <UIProvider value={shadcnProvider}>...</UIProvider>
 * </UIPluginProvider>
 * ```
 */
export function UIPluginProvider({
  plugins,
  children,
}: {
  plugins: UIPlugin[];
  children: ReactNode;
}) {
  const registry = useMemo(() => buildRegistry(plugins), [plugins]);
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

export function useUIRegistry(): UIRegistry {
  return useContext(RegistryContext);
}

// Narrow accessors. Pages read these so plugin authors don't need to know the
// full registry shape, and so the contract is auditable from one file.

export const useNavItems = () => useUIRegistry().nav;
export const useDashboardTiles = () => useUIRegistry().dashboardTiles;
export const useUsersColumns = () => useUIRegistry().usersColumns;
export const useUsersToolbar = () => useUIRegistry().usersToolbar;
export const useUserDetailSections = () => useUIRegistry().userDetailSections;
export const useUserDetailActions = () => useUIRegistry().userDetailActions;
export const useGamesColumns = () => useUIRegistry().gamesColumns;
export const usePlayersColumns = () => useUIRegistry().playersColumns;
export const usePlayerDetailSections = () => useUIRegistry().playerDetailSections;
export const usePlayerDetailActions = () => useUIRegistry().playerDetailActions;
export const useRegisteredRoutes = () => useUIRegistry().routes;

/**
 * Render a plugin-registered admin route by path. Consumers stub a Next page
 * file (`app/admin/(authed)/vip/page.tsx`) that just calls this helper.
 */
export function RegisteredRoute({ path }: { path: string }) {
  const routes = useRegisteredRoutes();
  const match = routes.find((r) => r.path === path);
  if (!match) {
    return (
      <div className="muted" style={{ padding: '2rem' }}>
        No UI plugin has registered the route <code>{path}</code>.
      </div>
    );
  }
  return <>{match.element}</>;
}
