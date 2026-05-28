'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { UIPlugin } from './define.js';
import { buildRegistry } from './define.js';
import { emptyRegistry, type UIRegistry } from './context.js';

const RegistryContext = createContext<UIRegistry>(emptyRegistry);

/**
 * Mount once near the top of your provider tree, above the admin shell.
 * Pass an empty array if you have no plugins yet.
 *
 * IMPORTANT: define plugins as stable module-level constants, not inline in JSX.
 * Inline arrays cause a new reference every render, re-running buildRegistry and
 * resetting error boundary state.
 *
 * @example
 * const plugins = [playerBadgesUI, vipTiersUI];
 * <UIPluginProvider plugins={plugins}>...</UIPluginProvider>
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

export const useNavItems = () => useUIRegistry().nav;
export const useRegisteredRoutes = () => useUIRegistry().routes;

/**
 * Render a plugin-registered admin route by path.
 * Consumers create a stub Next page that calls this component.
 *
 * @example
 * // apps/backoffice/app/(authed)/badges/page.tsx
 * export default function Page() {
 *   return <RegisteredRoute path="/admin/badges" />;
 * }
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
