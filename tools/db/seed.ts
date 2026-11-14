#!/usr/bin/env node
/**
 * Populate the local database so the backoffice has something realistic to show.
 * Run via `pnpm db:seed`. Safe to re-run: reference data converges, demo content is recreated,
 * and the admin password is reset to the one given.
 *
 * Thin wrapper over `seedLocalData` from `@openora/core/seed/local` - a create:app consumer runs
 * the same seeder from its own `pnpm db:seed`.
 *
 *   pnpm db:seed                       # 36 players, admin@oss.dev / password1234
 *   pnpm db:seed --players=60          # more players
 *   pnpm db:seed --admin-email=me@x.io --admin-password=secret123
 *
 * Requires DATABASE_URL (falls back to the local docker default). Single-tenant
 * since ADR-0026 - one DB role, no RLS.
 */
import { seedLocalData } from '@openora/core/seed/local';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const result = await seedLocalData({
    databaseUrl:
      process.env['DATABASE_ADMIN_URL'] ??
      process.env['DATABASE_URL'] ??
      'postgresql://postgres:postgres@localhost:5432/oss_igaming',
    playerCount: Number(arg('players') ?? 36),
    playerPassword: arg('password') ?? 'password1234',
    admin: {
      email: arg('admin-email') ?? 'admin@oss.dev',
      password: arg('admin-password') ?? 'password1234',
    },
    log: (m) => console.log(`  ${m}`),
  });

  console.log('\n=== Seed complete ===');
  console.log(`  Users:        ${result.users} (1 admin + ${result.players} players)`);
  console.log(`  Players:      ${result.players}`);
  console.log(`  Games:        ${result.games}`);
  console.log(`  Transactions: ${result.transactions}`);
  console.log(`  Chat rooms:   ${result.rooms}`);
  console.log('\nLog in to the backoffice:');
  console.log(`  ${result.adminEmail} / ${result.adminPassword}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nSeed failed:', e);
    process.exit(1);
  });
