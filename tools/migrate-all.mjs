#!/usr/bin/env node
// Unified migration runner across the core central history + every gated add-on's
// own history. Each set tracks its applied migrations in its own table
// (__drizzle_migrations[_addon_<name>]) so the sets never collide on one DB.
//
// Order: core central first (it owns the shared substrate - identity/user, wallet,
// the `player` table, etc.), then each gated add-on history. The add-ons fold into
// @oss/core as subpaths (ADR-0025), each exposing a runtime migrate() entry; the
// ones that own tables are sportsbook, casino (aggregator) and engagement
// (leaderboard). player-management reads the core `player` table and owns none, so
// has no migrate entry and is skipped.
//
// Every set uses the runtime migrator (drizzle-orm, @oss/core/server/migrate) - the
// same path a published consumer runs from node_modules - NOT the drizzle-kit `migrate`
// CLI (dev-only authoring tool, and it crashes on Node >=26). One code path for all.
//
// Requires @oss/core to be built (the migrate entries resolve to dist) and
// DATABASE_ADMIN_URL or DATABASE_URL set. See docs/adr/0020 + ADR-0025.

// 1) Core central history.
process.stdout.write('\n> migrate @oss/core (central history)\n');
const { migrate: migrateCore } = await import('@oss/core/server/migrate');
await migrateCore();

// 2) Gated add-on histories folded into @oss/core (own tracking table + SQL).
const gated = ['sportsbook', 'casino', 'engagement']; // sportsbook, aggregator, leaderboard
for (const name of gated) {
  process.stdout.write(`\n> migrate @oss/core/${name} (gated history)\n`);
  const { migrate } = await import(`@oss/core/${name}/migrate`);
  await migrate();
}

process.stdout.write(`\nDone: core + ${gated.length} gated migration set(s) applied.\n`);
