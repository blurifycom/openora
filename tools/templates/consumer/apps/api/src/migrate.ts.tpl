/**
 * Migration runner. Applies every enabled @blurifycom/core migration set against
 * DATABASE_URL (or DATABASE_ADMIN_URL). Resolves @blurifycom/core from node_modules,
 * so it works whether the package is a local `link:` or a published npm install -
 * no platform checkout required. Each set tracks itself in its own table, so order is
 * not load-bearing and re-runs are idempotent. See ADR-0027.
 *
 * Usage: pnpm db:migrate  (run before db:seed). Requires DATABASE_URL.
 * Add or remove a line to match the modules you enable in extensions.config.ts.
 */
const sets: ReadonlyArray<readonly [string, string]> = [
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
  // Gated add-ons - uncomment the ones you enable:
  // ['sportsbook', '@blurifycom/core/sportsbook/migrate'],
];

async function main() {
  if (!process.env['DATABASE_ADMIN_URL'] && !process.env['DATABASE_URL']) {
    console.error('Cannot run migrations: set DATABASE_URL (or DATABASE_ADMIN_URL).');
    process.exit(1);
  }

  for (const [label, specifier] of sets) {
    process.stdout.write(`\n> migrate ${label}\n`);
    const { migrate } = (await import(specifier)) as { migrate: () => Promise<void> };
    await migrate();
  }

  process.stdout.write(`\nDone: ${sets.length} migration set(s) applied.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nMigrate failed:', e);
    process.exit(1);
  });
