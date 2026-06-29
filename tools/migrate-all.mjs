#!/usr/bin/env node
// Applies every migration set in the build. Each set tracks its applied migrations in its own
// table (__drizzle_migrations_<id>) so they never collide while sharing one database. Uses the
// runtime migrator (drizzle-orm), NOT drizzle-kit migrate (crashes on Node >=26). Requires
// @blurifycom/core to be built and DATABASE_ADMIN_URL or DATABASE_URL set. See ADR-0020/0025/0027.

// No FK crosses a module boundary, so order is not load-bearing; engine first, then core, then gated.
const sets = [
  ['engine outbox', '@blurifycom/core/server/migrate'],
  ['audit', '@blurifycom/core/audit/migrate'],
  ['iam', '@blurifycom/core/iam/migrate'],
  ['identity', '@blurifycom/core/pam/migrate/identity'],
  ['profile', '@blurifycom/core/pam/migrate/profile'],
  ['wallet', '@blurifycom/core/wallet/migrate'],
  ['gaming', '@blurifycom/core/casino/migrate/gaming'],
  ['lobby', '@blurifycom/core/casino/migrate/lobby'],
  ['chat', '@blurifycom/core/engagement/migrate/chat'],
  ['bonus', '@blurifycom/core/engagement/migrate/bonus'],
  ['notifications', '@blurifycom/core/engagement/migrate/notifications'],
  ['compliance', '@blurifycom/core/compliance/migrate'],
  ['cms', '@blurifycom/core/cms/migrate'],
  ['sportsbook (gated)', '@blurifycom/core/sportsbook/migrate'],
  ['aggregator (gated)', '@blurifycom/core/casino/migrate'],
  ['leaderboard (gated)', '@blurifycom/core/engagement/migrate'],
];

for (const [label, specifier] of sets) {
  process.stdout.write(`\n> migrate ${label}\n`);
  const { migrate } = await import(specifier);
  await migrate();
}

process.stdout.write(`\nDone: ${sets.length} migration set(s) applied.\n`);
