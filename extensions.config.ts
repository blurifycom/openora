// Plugin registry. Every module and overlay extension must be listed here.
// The plugin-host loads these at boot, in top-to-bottom order (respecting dependsOn).
// Add entries via `pnpm gen module <name>` or `pnpm gen plugin <name>`.
//
// Every module lives under packages/core/src/<domain>/<module>/ (compiled to
// dist/<domain>/<module>/plugin.js) and owns its route contract slice (its /contract
// dir). Downstream consumers compose the contract slices they enable. See ADR-0025.

export const extensions = [
  { id: 'social', path: './packages/core/dist/engagement/social/plugin.js' },
  // --- MODULES (always loaded) ---
  { id: 'audit', path: './packages/core/dist/audit/plugin.js' },
  { id: 'iam', path: './packages/core/dist/iam/plugin.js' },
  // Platform - shared substrate used by both surfaces
  { id: 'identity', path: './packages/core/dist/pam/identity/plugin.js' },
  { id: 'mail', path: './packages/core/dist/mail/plugin.js' },
  { id: 'notifications', path: './packages/core/dist/engagement/notifications/plugin.js' },
  { id: 'compliance', path: './packages/core/dist/compliance/plugin.js' },
  { id: 'exchange-rate', path: './packages/core/dist/fx/exchange-rate/plugin.js' },

  // Player - the player-facing igaming surface
  { id: 'wallet', path: './packages/core/dist/wallet/plugin.js' },
  { id: 'gaming', path: './packages/core/dist/casino/gaming/plugin.js' },
  { id: 'lobby', path: './packages/core/dist/casino/lobby/plugin.js' },
  { id: 'chat', path: './packages/core/dist/engagement/chat/plugin.js' },
  { id: 'chat-commands', path: './packages/core/dist/engagement/chat-commands/plugin.js' },
  // Player self-profile (owns the `player` table); the admin PAM surface is
  // player-management below, which reads that table via the /schema subpath.
  { id: 'profile', path: './packages/core/dist/pam/profile/plugin.js' },
  { id: 'tag', path: './packages/core/dist/pam/tag/plugin.js' },

  // Backoffice - the admin/operator surface
  { id: 'admin-console', path: './packages/core/dist/admin-console/plugin.js' },
  { id: 'analytics', path: './packages/core/dist/analytics/plugin.js' },
  { id: 'player-note', path: './packages/core/dist/pam/player-note/plugin.js' },
  { id: 'cms', path: './packages/core/dist/cms/plugin.js' },

  { id: 'player-management', path: './packages/core/dist/pam/player-management/plugin.js' },

  // Overlay extensions (<your-app>/src/extensions/<name>/plugin.ts)
  // Add via: pnpm gen plugin <name>
  // Consumer apps add their own overlay entries here (eg RabbitMQ, custom adapters).
  // The platform ships in-process defaults plus Redis-backed reference drivers that
  // auto-bind when REDIS_URL is set: BullMQ for JOB_QUEUE (durable jobs, real cron) and
  // the Redis cache/rate-limiter (ADR-0028). MESSAGE_BROKER stays in-process (AMQP_URL
  // enables the outbox; a durable broker is still an overlay). Rebind any of these
  // with your own infra plugin (Container last-wins).
];
