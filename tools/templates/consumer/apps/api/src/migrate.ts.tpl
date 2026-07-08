/**
 * Migration runner. Applies every enabled @openora/core migration set against
 * DATABASE_URL (or DATABASE_ADMIN_URL). Resolves @openora/core from node_modules,
 * so it works whether the package is a local `link:` or a published npm install -
 * no platform checkout required. Each set tracks itself in its own table, so order is
 * not load-bearing and re-runs are idempotent. See ADR-0027.
 *
 * Usage: pnpm db:migrate  (run before db:seed). Requires DATABASE_URL.
 * Add or remove a line to match the modules you enable in extensions.config.ts.
 */
const sets: ReadonlyArray<readonly [string, string]> = [
  ['engine outbox', '@openora/core/server/migrate'],
  ['audit', '@openora/core/audit/migrate'],
  ['iam', '@openora/core/iam/migrate'],
  ['identity', '@openora/core/pam/migrate/identity'],
  ['profile', '@openora/core/pam/migrate/profile'],
  ['wallet', '@openora/core/wallet/migrate'],
  ['gaming', '@openora/core/casino/migrate/gaming'],
  ['lobby', '@openora/core/casino/migrate/lobby'],
  ['chat', '@openora/core/engagement/migrate/chat'],
  ['notifications', '@openora/core/engagement/migrate/notifications'],
  ['compliance', '@openora/core/compliance/migrate'],
  ['cms', '@openora/core/cms/migrate'],
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
