#!/usr/bin/env node
/**
 * Populate the local database with demo data so the backoffice has something
 * realistic to show. Run via `pnpm seed`. Idempotent - safe to re-run.
 *
 *   pnpm seed                       # 36 players, admin@oss.dev / password123
 *   pnpm seed --players=60          # more players
 *   pnpm seed --admin-email=me@x.io --admin-password=secret123
 *
 * Requires DATABASE_URL (falls back to the local docker default). Single-tenant
 * since ADR-0026 - one DB role, no RLS.
 */
import { createAuth } from '@oss/core/server';
import { createDrizzleDb } from '@oss/core/server';
import { seedDemoData } from '@oss/testing';
import { user, session, account, verification, twoFactor } from '@oss/core/pam/schema/identity';

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
  // user creation throws "model user not found". See @oss/core/server createAuth().
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
