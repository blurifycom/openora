#!/usr/bin/env node
// Each migration set tracks its applied migrations in its own table so they never collide.
// Uses the runtime migrator (drizzle-orm), NOT drizzle-kit migrate (crashes on Node >=26).
// Requires @blurifycom/core to be built and DATABASE_ADMIN_URL or DATABASE_URL set. See ADR-0020/0025.

process.stdout.write('\n> migrate @blurifycom/core (central history)\n');
const { migrate: migrateCore } = await import('@blurifycom/core/server/migrate');
await migrateCore();

const gated = ['sportsbook', 'casino', 'engagement']; // sportsbook, aggregator, leaderboard
for (const name of gated) {
  process.stdout.write(`\n> migrate @blurifycom/core/${name} (gated history)\n`);
  const { migrate } = await import(`@blurifycom/core/${name}/migrate`);
  await migrate();
}

process.stdout.write(`\nDone: core + ${gated.length} gated migration set(s) applied.\n`);
