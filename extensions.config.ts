// Plugin registry. Every module and overlay extension must be listed here.
// The plugin-host loads these at API boot, in top-to-bottom order (respecting dependsOn).
// Add entries via `pnpm scaffold module <name>` or `pnpm scaffold plugin <name>`.

export const extensions = [
  // Core OSS modules
  { id: 'identity', path: './packages/modules/identity/dist/plugin.js' },
  { id: 'wallet', path: './packages/modules/wallet/dist/plugin.js' },
  { id: 'notifications', path: './packages/modules/notifications/dist/plugin.js' },
  { id: 'gaming', path: './packages/modules/gaming/dist/plugin.js' },
  { id: 'lobby', path: './packages/modules/lobby/dist/plugin.js' },
  { id: 'chat', path: './packages/modules/chat/dist/plugin.js' },
  { id: 'bonus', path: './packages/modules/bonus/dist/plugin.js' },
  { id: 'compliance', path: './packages/modules/compliance/dist/plugin.js' },
  { id: 'backoffice', path: './packages/modules/backoffice/dist/plugin.js' },
  { id: 'player', path: './packages/modules/player/dist/plugin.js' },
  { id: 'cms', path: './packages/modules/cms/dist/plugin.js' },
  { id: 'localization', path: './packages/modules/localization/dist/plugin.js' },
  { id: 'casino-aggregator', path: './packages/modules/casino-aggregator/dist/plugin.js' },

  // Overlay extensions (apps/extensions/<name>/plugin.ts)
  // Add via: pnpm scaffold plugin <name>
];
