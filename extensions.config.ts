// Plugin registry. Every add-on and overlay extension must be listed here.
// The plugin-host loads these at API boot, in top-to-bottom order (respecting dependsOn).
// Add entries via `pnpm gen module <name>` or `pnpm gen plugin <name>`.
//
// Every feature is a standalone @oss-addons/<name> package under packages/addons/<name>/
// (compiled to dist/plugin.js). Core add-ons (no `kind`) always load and keep their route
// contracts in @oss/orpc-contract; gated add-ons (`kind: 'addon'`) load only when listed in
// the OSS_ADDONS allowlist and carry their own contract slice. See ADR-0021.

export const extensions = [
  // --- CORE ADD-ONS (always loaded; contracts live in @oss/orpc-contract) ---
  { id: 'audit', path: './packages/addons/audit/dist/plugin.js' },
  { id: 'iam', path: './packages/addons/iam/dist/plugin.js' },
  // Platform - shared substrate used by both surfaces
  { id: 'identity', path: './packages/addons/identity/dist/plugin.js' },
  { id: 'notifications', path: './packages/addons/notifications/dist/plugin.js' },
  { id: 'compliance', path: './packages/addons/compliance/dist/plugin.js' },

  // Player - the player-facing igaming surface
  { id: 'wallet', path: './packages/addons/wallet/dist/plugin.js' },
  { id: 'gaming', path: './packages/addons/gaming/dist/plugin.js' },
  { id: 'lobby', path: './packages/addons/lobby/dist/plugin.js' },
  { id: 'chat', path: './packages/addons/chat/dist/plugin.js' },
  { id: 'bonus', path: './packages/addons/bonus/dist/plugin.js' },
  // Player self-profile (owns the `player` table). The admin PAM surface is the
  // gated player-management add-on below.
  { id: 'profile', path: './packages/addons/profile/dist/plugin.js' },

  // Backoffice - the admin/operator surface
  { id: 'admin-console', path: './packages/addons/admin-console/dist/plugin.js' },
  { id: 'cms', path: './packages/addons/cms/dist/plugin.js' },

  // --- GATED ADD-ONS (optional, extract-later packages under packages/addons/*) ---
  // kind: 'addon' -> loaded by the composition root ONLY when the id is in the
  // OSS_ADDONS allowlist (apps/api/src/editions.ts). Default build omits them
  // entirely (no routes, no OpenAPI). Each ships its own contract slice +
  // migrations and can be lifted to its own npm package. See ADR-0020/ADR-0021.
  { id: 'leaderboard', path: './packages/addons/leaderboard/dist/plugin.js', kind: 'addon' },
  { id: 'sportsbook', path: './packages/addons/sportsbook/dist/plugin.js', kind: 'addon' },
  // sportsbook debits the core wallet via WALLET_COMMANDS (dependsOn: ['wallet']).
  { id: 'aggregator', path: './packages/addons/aggregator/dist/plugin.js', kind: 'addon' },
  // Admin PAM. Reads the core `player` table (owned by the profile module) via the
  // /schema subpath; the player-facing profile stays free.
  {
    id: 'player-management',
    path: './packages/addons/player-management/dist/plugin.js',
    kind: 'addon',
  },

  // Overlay extensions (apps/api/src/extensions/<name>/plugin.ts)
  // Add via: pnpm gen plugin <name>
  //
  // Durable job-queue driver. Self-disabling: rebinds JOB_QUEUE to BullMQ only
  // when REDIS_URL is set, otherwise leaves the in-process default (safe for
  // dev/test/CI). See ADR-0014.
  { id: 'bullmq', path: './apps/api/dist/extensions/bullmq/plugin.js', kind: 'infra' },
  //
  // Durable inter-module broker. Self-disabling: rebinds MESSAGE_BROKER to
  // RabbitMQ only when AMQP_URL is set, otherwise leaves the in-process default
  // (safe for dev/test/CI). The EventBus owns the wire envelope, so this is a
  // zero-module-change swap and the migration path to Kafka. See ADR-0016.
  { id: 'rabbitmq', path: './apps/api/dist/extensions/rabbitmq/plugin.js', kind: 'infra' },
];
