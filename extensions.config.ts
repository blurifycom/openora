// Plugin registry. Every module and overlay extension must be listed here.
// The plugin-host loads these at API boot, in top-to-bottom order (respecting dependsOn).
// Add entries via `pnpm gen module <group> <name>` or `pnpm gen plugin <name>`.
//
// Modules are grouped under packages/modules/{player,backoffice,platform}/ and
// compiled into the single @oss/modules package (dist/<group>/<name>/src/plugin.js).

export const extensions = [
  { id: 'audit', path: './packages/modules/dist/backoffice/audit/src/plugin.js' },
  { id: 'iam', path: './packages/modules/dist/backoffice/iam/src/plugin.js' },
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
  // Player self-profile (owns the `player` table). The admin PAM surface is the
  // premium player-management package below.
  { id: 'profile', path: './packages/modules/dist/player/profile/src/plugin.js' },

  // Backoffice - the admin/operator surface
  { id: 'admin-console', path: './packages/modules/dist/backoffice/admin-console/src/plugin.js' },
  { id: 'cms', path: './packages/modules/dist/backoffice/cms/src/plugin.js' },

  // --- PREMIUM (sellable, extract-later packages under packages/premium/*) ---
  // kind: 'premium' -> loaded by the composition root ONLY when the id is in the
  // OSS_PREMIUM allowlist (apps/api/src/editions.ts). Free edition omits them
  // entirely (no routes, no OpenAPI). Each ships its own contract slice +
  // migrations and can be lifted to its own npm package. See ADR-0020.
  { id: 'leaderboard', path: './packages/premium/leaderboard/dist/plugin.js', kind: 'premium' },
  { id: 'sportsbook', path: './packages/premium/sportsbook/dist/plugin.js', kind: 'premium' },
  // sportsbook debits the core wallet via WALLET_COMMANDS (dependsOn: ['wallet']).
  { id: 'aggregator', path: './packages/premium/aggregator/dist/plugin.js', kind: 'premium' },
  // Admin PAM. Reads the core `player` table (owned by the profile module) via the
  // /schema subpath; the player-facing profile stays free.
  {
    id: 'player-management',
    path: './packages/premium/player-management/dist/plugin.js',
    kind: 'premium',
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
