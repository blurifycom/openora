import { createRequire } from 'node:module';
import type { PluginEntry } from './load-plugins.js';

const nodeRequire = createRequire(import.meta.url);

const CORE_PLUGIN_MODULES = [
  { id: 'audit', specifier: '@openora/core/audit/plugin' },
  { id: 'identity', specifier: '@openora/core/pam/plugins/identity' },
  { id: 'iam', specifier: '@openora/core/iam/plugin' },
  { id: 'notifications', specifier: '@openora/core/engagement/plugins/notifications' },
  { id: 'wallet', specifier: '@openora/core/wallet/plugins/wallet' },
  { id: 'gaming', specifier: '@openora/core/casino/plugins/gaming' },
  { id: 'lobby', specifier: '@openora/core/casino/plugins/lobby' },
  { id: 'chat', specifier: '@openora/core/engagement/plugins/chat' },
  { id: 'profile', specifier: '@openora/core/pam/plugins/profile' },
  { id: 'tag', specifier: '@openora/core/pam/plugins/tag' },
  { id: 'player-management', specifier: '@openora/core/pam/plugins/player-management' },
  { id: 'compliance', specifier: '@openora/core/compliance/plugins/compliance' },
  { id: 'admin-console', specifier: '@openora/core/admin-console/plugin' },
  { id: 'analytics', specifier: '@openora/core/analytics/plugin' },
  { id: 'player-note', specifier: '@openora/core/pam/plugins/player-note' },
  { id: 'cms', specifier: '@openora/core/cms/plugins/cms' },
] as const;

/**
 * The full set of built-in platform plugins, as a ready-to-spread
 * `PluginEntry[]` for a consumer's `extensions.config.ts`.
 *
 * Each path is resolved through `@openora/core`'s own package exports, so it
 * points at the installed package's compiled plugin - the npm dependency in a
 * deployed consumer, or the linked workspace checkout in local development.
 * This replaces hand-maintained filesystem paths that assumed an adjacent core
 * checkout.
 *
 * Compose your registry as `[...corePlugins(), ...overlays]`. To opt a module
 * out, filter by id: `corePlugins().filter((p) => p.id !== 'chat')`.
 */
export function corePlugins(): PluginEntry[] {
  return CORE_PLUGIN_MODULES.map((module) => ({
    id: module.id,
    path: nodeRequire.resolve(module.specifier),
  }));
}
