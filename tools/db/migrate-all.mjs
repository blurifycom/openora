#!/usr/bin/env node
// Applies every migration set in the build. Each set tracks its applied migrations in its own
// table (__drizzle_migrations_<id>) so they never collide while sharing one database. Uses the
// runtime migrator (drizzle-orm), NOT drizzle-kit migrate (crashes on Node >=26). Requires
// @openora/core to be built and DATABASE_ADMIN_URL or DATABASE_URL set. See ADR-0020/0025/0027.

// No FK crosses a module boundary, so order is not load-bearing; engine first, then core, then gated.
const sets = [
  ['engine outbox', '@openora/core/server/migrate'],
  ['audit', '@openora/core/audit/migrate'],
  ['iam', '@openora/core/iam/migrate'],
  ['identity', '@openora/core/pam/migrate/identity'],
  ['tag', '@openora/core/pam/migrate/tag'],
  ['player-note', '@openora/core/pam/migrate/player-note'],
  ['profile', '@openora/core/pam/migrate/profile'],
  ['wallet', '@openora/core/wallet/migrate'],
  ['gaming', '@openora/core/casino/migrate/gaming'],
  ['lobby', '@openora/core/casino/migrate/lobby'],
  ['chat', '@openora/core/engagement/migrate/chat'],
  ['bonus', '@openora/core/engagement/migrate/bonus'],
  ['notifications', '@openora/core/engagement/migrate/notifications'],
  ['compliance', '@openora/core/compliance/migrate'],
  ['cms', '@openora/core/cms/migrate'],
  ['sportsbook (gated)', '@openora/core/sportsbook/migrate'],
  ['aggregator (gated)', '@openora/core/casino/migrate'],
  ['leaderboard (gated)', '@openora/core/engagement/migrate'],
];

for (const [label, specifier] of sets) {
  process.stdout.write(`\n> migrate ${label}\n`);
  const { migrate } = await import(specifier);
  await migrate();
}

process.stdout.write(`\nDone: ${sets.length} migration set(s) applied.\n`);
