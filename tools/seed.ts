#!/usr/bin/env node
/**
 * Populate the local database with demo data so the backoffice has something
 * realistic to show. Run via `pnpm seed`. Idempotent - safe to re-run.
 *
 *   pnpm seed                       # 36 players, admin@oss.dev / password123
 *   pnpm seed --players=60          # more players
 *   pnpm seed --admin-email=me@x.io --admin-password=secret123
 *
 * Requires DATABASE_URL (falls back to the local docker default). Seed is a
 * system path: it writes across tenants, so it connects with the BYPASSRLS role
 * (DATABASE_ADMIN_URL when set, else DATABASE_URL). See ADR-0018.
 */
import { createAuth } from '@oss/auth';
import { createDrizzleDb } from '@oss/db';
import { seedDemoData } from '@oss/api-runtime';
import { user, session, account, verification, twoFactor } from '@oss/modules/platform/identity/schema';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const databaseUrl =
    process.env['DATABASE_ADMIN_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgresql://postgres:postgres@localhost:5432/oss_igaming';
  const db = createDrizzleDb(databaseUrl);
  // better-auth's drizzle adapter needs the auth tables passed as schema, else
  // user creation throws "model user not found". See @oss/auth createAuth().
  const auth = createAuth({ db, schema: { user, session, account, verification, twoFactor } });

  const result = await seedDemoData({
    db,
    auth,
    playerCount: Number(arg('players') ?? 36),
    admin: {
      email: arg('admin-email') ?? 'admin@oss.dev',
      password: arg('admin-password') ?? 'password123',
      name: 'Platform Admin',
    },
    log: (m) => console.log(`  ${m}`),
  });

  console.log('\n=== Seed complete ===');
  console.log(`  Users:        ${result.users} (1 admin + ${result.players} players)`);
  console.log(`  Players:      ${result.players}`);
  console.log(`  Games:        ${result.games}`);
  console.log(`  Transactions: ${result.transactions}`);
  console.log('\nLog in to the backoffice:');
  console.log(`  ${result.adminEmail} / ${result.adminPassword}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nSeed failed:', e);
    process.exit(1);
  });
