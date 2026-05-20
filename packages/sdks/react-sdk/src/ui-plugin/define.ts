import type { UIPluginContext, UIRegistry } from './context.js';
import { emptyRegistry } from './context.js';

export type UIPlugin = {
  id: string;
  register: (ctx: UIPluginContext) => void;
};

/**
 * Define a UI plugin. The `register` function is called once when the
 * `<UIPluginProvider>` mounts; each `ctx.<slot>.add(...)` call appends to the
 * internal registry. After registration the registry is frozen for the
 * lifetime of the provider.
 *
 * Server-side plugin contributions (Nest providers, oRPC routers) live in a
 * separate `definePlugin({ register })` call - see ADR-0002 / ADR-0006.
 */
export function defineUIPlugin(plugin: UIPlugin): UIPlugin {
  return plugin;
}

const byOrder = <T extends { order?: number }>(a: T, b: T): number =>
  (a.order ?? 100) - (b.order ?? 100);

/**
 * Run every plugin's `register` against a fresh registry. Used by the
 * provider; exposed for tests.
 */
export function buildRegistry(plugins: UIPlugin[]): UIRegistry {
  const reg: UIRegistry = {
    nav: [...emptyRegistry.nav],
    dashboardTiles: [...emptyRegistry.dashboardTiles],
    usersColumns: [...emptyRegistry.usersColumns],
    usersToolbar: [...emptyRegistry.usersToolbar],
    userDetailSections: [...emptyRegistry.userDetailSections],
    userDetailActions: [...emptyRegistry.userDetailActions],
    gamesColumns: [...emptyRegistry.gamesColumns],
    playersColumns: [...emptyRegistry.playersColumns],
    playerDetailSections: [...emptyRegistry.playerDetailSections],
    playerDetailActions: [...emptyRegistry.playerDetailActions],
    routes: [...emptyRegistry.routes],
  };

  const ctx: UIPluginContext = {
    nav: { add: (item) => reg.nav.push(item) },
    dashboard: { tiles: { add: (t) => reg.dashboardTiles.push(t) } },
    users: {
      columns: { add: (c) => reg.usersColumns.push(c) },
      toolbar: { add: (t) => reg.usersToolbar.push(t) },
    },
    userDetail: {
      sections: { add: (s) => reg.userDetailSections.push(s) },
      actions: { add: (a) => reg.userDetailActions.push(a) },
    },
    games: { columns: { add: (c) => reg.gamesColumns.push(c) } },
    players: { columns: { add: (c) => reg.playersColumns.push(c) } },
    playerDetail: {
      sections: { add: (s) => reg.playerDetailSections.push(s) },
      actions: { add: (a) => reg.playerDetailActions.push(a) },
    },
    routes: { add: (r) => reg.routes.push(r) },
  };

  const seenIds = new Set<string>();
  for (const plugin of plugins) {
    if (seenIds.has(plugin.id)) {
      throw new Error(`@oss/react-sdk: duplicate UI plugin id "${plugin.id}"`);
    }
    seenIds.add(plugin.id);
    plugin.register(ctx);
  }

  // Stable sort by `order` within each ordered slot.
  reg.dashboardTiles.sort(byOrder);
  reg.usersToolbar.sort(byOrder);
  reg.userDetailSections.sort(byOrder);
  reg.userDetailActions.sort(byOrder);
  reg.playerDetailSections.sort(byOrder);
  reg.playerDetailActions.sort(byOrder);

  return reg;
}
