// Plugin registry. Every add-on and overlay extension must be listed here.
// The plugin-host loads these at boot, in top-to-bottom order (respecting dependsOn).
// Add entries via `pnpm gen module <name>` or `pnpm gen plugin <name>`.
//
// Every feature is a standalone @blurifycom-addons/<name> package under packages/addons/<name>/
// (compiled to dist/plugin.js). Core add-ons (no `kind`) always load and own their route
// contract slice (its /contract dir), composed in tools/build-contract.ts; gated add-ons
// (`kind: 'addon'`) load only when listed in the OSS_ADDONS allowlist. See ADR-0021/0025.

export const extensions = [
  // --- CORE ADD-ONS (always loaded; contracts composed in tools/build-contract.ts) ---
  { id: 'audit', path: './packages/core/dist/audit/plugin.js' },
  { id: 'iam', path: './packages/core/dist/iam/plugin.js' },
  // Platform - shared substrate used by both surfaces
  { id: 'identity', path: './packages/core/dist/pam/identity/plugin.js' },
  { id: 'notifications', path: './packages/core/dist/engagement/notifications/plugin.js' },
  { id: 'compliance', path: './packages/core/dist/compliance/plugin.js' },

  // Player - the player-facing igaming surface
  { id: 'wallet', path: './packages/core/dist/wallet/plugin.js' },
  { id: 'gaming', path: './packages/core/dist/casino/gaming/plugin.js' },
  { id: 'lobby', path: './packages/core/dist/casino/lobby/plugin.js' },
  { id: 'chat', path: './packages/core/dist/engagement/chat/plugin.js' },
  { id: 'bonus', path: './packages/core/dist/engagement/bonus/plugin.js' },
  // Player self-profile (owns the `player` table). The admin PAM surface is the
  // gated player-management add-on below.
  { id: 'profile', path: './packages/core/dist/pam/profile/plugin.js' },
  { id: 'tag', path: './packages/core/dist/pam/tag/plugin.js' },

  // Backoffice - the admin/operator surface
  { id: 'admin-console', path: './packages/core/dist/admin-console/plugin.js' },
  { id: 'player-note', path: './packages/core/dist/pam/player-note/plugin.js' },
  { id: 'cms', path: './packages/core/dist/cms/plugin.js' },

  // --- GATED ADD-ONS (optional, extract-later packages under packages/addons/*) ---
  // kind: 'addon' -> loaded ONLY when the id is in the OSS_ADDONS allowlist.
  // Default build omits them entirely (no routes, no OpenAPI). Each ships its own
  // contract slice + migrations and can be lifted to its own npm package. See ADR-0020/ADR-0021.
  {
    id: 'leaderboard',
    path: './packages/core/dist/engagement/leaderboard/plugin.js',
    kind: 'addon',
  },
  { id: 'sportsbook', path: './packages/core/dist/sportsbook/plugin.js', kind: 'addon' },
  // sportsbook debits the core wallet via WALLET_COMMANDS (dependsOn: ['wallet']).
  { id: 'aggregator', path: './packages/core/dist/casino/aggregator/plugin.js', kind: 'addon' },
  // Admin PAM. Reads the core `player` table (owned by the profile module) via the
  // /schema subpath; the player-facing profile stays free.
  {
    id: 'player-management',
    path: './packages/core/dist/pam/player-management/plugin.js',
    kind: 'addon',
  },

  // Overlay extensions (<your-app>/src/extensions/<name>/plugin.ts)
  // Add via: pnpm gen plugin <name>
  // Consumer apps add their own overlay entries here (eg BullMQ, RabbitMQ,
  // custom adapters). The platform ships in-process defaults for JOB_QUEUE and
  // MESSAGE_BROKER; bind a durable driver by adding your own infra plugin.
];
