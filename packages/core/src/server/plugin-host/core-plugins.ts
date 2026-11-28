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
  { id: 'chat-commands', path: '@openora/core/engagement/plugins/chat-commands' },
  { id: 'social', path: '@openora/core/engagement/plugins/social' },
  { id: 'chat-remote', path: '@openora/core/engagement/plugins/chat-remote' },
  { id: 'money-remote', path: '@openora/core/money-remote/plugin' },
  { id: 'profile', path: '@openora/core/pam/plugins/profile' },
  { id: 'tag', path: '@openora/core/pam/plugins/tag' },
  { id: 'player-management', path: '@openora/core/pam/plugins/player-management' },
  { id: 'compliance', path: '@openora/core/compliance/plugins/compliance' },
  { id: 'admin-console', path: '@openora/core/admin-console/plugin' },
  { id: 'analytics', path: '@openora/core/analytics/plugin' },
  { id: 'player-note', path: '@openora/core/pam/plugins/player-note' },
  { id: 'cms', path: '@openora/core/cms/plugins/cms' },
] as const;

export function corePlugins(): PluginEntry[] {
  return CORE_PLUGIN_MODULES.map((module) => ({
    id: module.id,
    path: nodeRequire.resolve(module.path),
  }));
}
