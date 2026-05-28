import type {
  UIRegistry,
  SlotFill,
  ColumnFill,
  SlotContribution,
  ColumnContribution,
  AppShellNavItem,
  RegisteredRouteDescriptor,
} from './context.js';
import { emptyRegistry } from './context.js';

/**
 * Declarative UI plugin descriptor.
 *
 * A plugin is a plain data object - no side effects, no builder API.
 * Every field is optional; include only what the plugin contributes.
 *
 * @example
 * export const myPlugin = defineUIPlugin({
 *   id: 'my-feature',
 *   nav:    [{ href: '/admin/x', label: 'X', icon: XIcon }],
 *   routes: [{ path: '/admin/x', element: <XPage /> }],
 *   slots: [
 *     {
 *       name: SLOTS.playerDetail.sections,
 *       id: 'x-section',
 *       mode: 'append',
 *       order: 40,
 *       render: defineSlotFill<Player>(p => <XSection player={p} />),
 *     },
 *   ],
 *   columns: [
 *     { name: SLOTS.players.columns, key: 'x', header: 'X', render: v => <XCell v={v} /> },
 *   ],
 * });
 */
export type UIPlugin = {
  id: string;
  /** Component slot fills (sections, tiles, actions, toolbar items) */
  slots?: SlotContribution[];
  /** DataTable column fills */
  columns?: ColumnContribution[];
  /** Sidebar nav items */
  nav?: AppShellNavItem[];
  /** Admin routes (consumers stub a Next page per route) */
  routes?: RegisteredRouteDescriptor[];
};

/**
 * Define a UI plugin. Returns the descriptor unchanged - exists for type checking
 * and to mark the export as a plugin for tooling.
 */
export function defineUIPlugin(plugin: UIPlugin): UIPlugin {
  return plugin;
}

/**
 * Merge all plugin contributions into an immutable UIRegistry.
 * Pure function - no side effects.
 */
export function buildRegistry(plugins: UIPlugin[]): UIRegistry {
  const slots = new Map<string, SlotFill[]>();
  const columns = new Map(emptyRegistry.columns);
  const nav: AppShellNavItem[] = [];
  const routes: RegisteredRouteDescriptor[] = [];

  const seenIds = new Set<string>();

  for (const plugin of plugins) {
    if (seenIds.has(plugin.id)) {
      throw new Error(`@oss/react-pages: duplicate UI plugin id "${plugin.id}"`);
    }
    seenIds.add(plugin.id);

    for (const s of plugin.slots ?? []) {
      const id = `${plugin.id}:${s.id}`;
      const list = slots.get(s.name) ?? [];
      const fill: SlotFill = {
        id,
        pluginId: plugin.id,
        order: s.order ?? 100,
        mode: s.mode ?? 'append',
        render: s.render,
      };
      if (s.visibleWhen) fill.visibleWhen = s.visibleWhen;
      if (s.requiresPermission !== undefined) fill.requiresPermission = s.requiresPermission;
      if (s.brandScope) fill.brandScope = s.brandScope;
      if (s.featureFlag) fill.featureFlag = s.featureFlag;
      list.push(fill);
      slots.set(s.name, list);
    }

    for (const c of plugin.columns ?? []) {
      const list = columns.get(c.name) ?? [];
      const col: ColumnFill = {
        pluginId: plugin.id,
        key: c.key,
        header: c.header,
      };
      if (c.render) col.render = c.render;
      if (c.visibleWhen) col.visibleWhen = c.visibleWhen;
      if (c.requiresPermission !== undefined) col.requiresPermission = c.requiresPermission;
      if (c.brandScope) col.brandScope = c.brandScope;
      if (c.featureFlag) col.featureFlag = c.featureFlag;
      list.push(col);
      columns.set(c.name, list);
    }

    nav.push(...(plugin.nav ?? []));
    routes.push(...(plugin.routes ?? []));
  }

  for (const fills of slots.values()) {
    fills.sort((a, b) => a.order - b.order);
  }

  return { slots, columns, nav, routes };
}
