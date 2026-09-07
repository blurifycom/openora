import { createRequire } from 'node:module';
import type { PluginEntry } from './load-plugins.js';

const nodeRequire = createRequire(import.meta.url);

const CORE_PLUGIN_MODULES = [
  { id: 'audit', path: '@openora/core/audit/plugin' },
  { id: 'identity', path: '@openora/core/pam/plugins/identity' },
  { id: 'iam', path: '@openora/core/iam/plugin' },
  { id: 'mail', path: '@openora/core/mail/plugin' },
  { id: 'notifications', path: '@openora/core/engagement/plugins/notifications' },
  { id: 'exchange-rate', path: '@openora/core/fx/plugins/exchange-rate' },
  { id: 'wallet', path: '@openora/core/wallet/plugins/wallet' },
  { id: 'gaming', path: '@openora/core/casino/plugins/gaming' },
  { id: 'lobby', path: '@openora/core/casino/plugins/lobby' },
  { id: 'chat', path: '@openora/core/engagement/plugins/chat' },
  { id: 'profile', path: '@openora/core/pam/plugins/profile' },
  { id: 'tag', path: '@openora/core/pam/plugins/tag' },
  { id: 'player-management', path: '@openora/core/pam/plugins/player-management' },
  { id: 'compliance', path: '@openora/core/compliance/plugins/compliance' },
  { id: 'admin-console', path: '@openora/core/admin-console/plugin' },
  { id: 'analytics', path: '@openora/core/analytics/plugin' },
  { id: 'player-note', path: '@openora/core/pam/plugins/player-note' },
  { id: 'cms', path: '@openora/core/cms/plugins/cms' },
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
    path: nodeRequire.resolve(module.path),
  }));
}
