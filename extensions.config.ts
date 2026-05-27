// Plugin registry. Every module and overlay extension must be listed here.
// The plugin-host loads these at API boot, in top-to-bottom order (respecting dependsOn).
// Add entries via `pnpm scaffold module <group> <name>` or `pnpm scaffold plugin <name>`.
//
// Modules are grouped under packages/modules/{player,backoffice,platform}/ and
// compiled into the single @oss/modules package (dist/<group>/<name>/src/plugin.js).

export const extensions = [
  { id: 'leaderboard', path: './packages/modules/dist/player/leaderboard/src/plugin.js' },
  // Platform - shared substrate used by both surfaces
  { id: 'identity', path: './packages/modules/dist/platform/identity/src/plugin.js' },
  { id: 'notifications', path: './packages/modules/dist/platform/notifications/src/plugin.js' },
  { id: 'compliance', path: './packages/modules/dist/platform/compliance/src/plugin.js' },
  { id: 'localization', path: './packages/modules/dist/platform/localization/src/plugin.js' },

  // Player - the player-facing igaming surface
  { id: 'wallet', path: './packages/modules/dist/player/wallet/src/plugin.js' },
  { id: 'gaming', path: './packages/modules/dist/player/gaming/src/plugin.js' },
  { id: 'lobby', path: './packages/modules/dist/player/lobby/src/plugin.js' },
  { id: 'chat', path: './packages/modules/dist/player/chat/src/plugin.js' },
  { id: 'bonus', path: './packages/modules/dist/player/bonus/src/plugin.js' },
  { id: 'aggregator', path: './packages/modules/dist/player/aggregator/src/plugin.js' },
  { id: 'sportsbook', path: './packages/modules/dist/player/sportsbook/src/plugin.js' },

  // Backoffice - the admin/operator surface
  { id: 'admin-console', path: './packages/modules/dist/backoffice/admin-console/src/plugin.js' },
  { id: 'player-management', path: './packages/modules/dist/backoffice/player-management/src/plugin.js' },
  { id: 'cms', path: './packages/modules/dist/backoffice/cms/src/plugin.js' },

  // Overlay extensions (apps/extensions/<name>/plugin.ts)
  // Add via: pnpm scaffold plugin <name>
];
