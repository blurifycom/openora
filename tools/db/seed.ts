#!/usr/bin/env node
/**
 * Populate the local database so the backoffice has something realistic to show.
 * Run via `pnpm seed`. Idempotent - safe to re-run.
 *
 * Two phases, both idempotent:
 *   1. Reference data - IAM's predefined roles (seedRoles, convergent upsert). Safe on any env.
 *   2. Demo data - admin + fake players + games + transactions (dev/local only).
 *
 * Seeding is a standalone one-shot script (mirrors tools/db/migrate-all.mjs) - it needs only a
 * DB connection, never boots the app. Reference seeders are composed explicitly here; the
 * consumer's own seed script does the same with the modules it enables.
 *
 *   pnpm seed                       # 36 players, admin@oss.dev / password123
 *   pnpm seed --players=60          # more players
 *   pnpm seed --admin-email=me@x.io --admin-password=secret123
 *
 * Requires DATABASE_URL (falls back to the local docker default). Single-tenant
 * since ADR-0026 - one DB role, no RLS.
 */
import { createAuth, createDrizzleDb } from '@openora/core/server';
import { seedIam } from '@openora/core/iam/seed';
import { seedTag } from '@openora/core/pam/tag/seed';
import { seedDemoData } from '@openora/testing';
import { user, session, account, verification, twoFactor } from '@openora/core/pam/schema/identity';

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
  // user creation throws "model user not found". See @openora/core/server createAuth().
  const auth = createAuth({ db, schema: { user, session, account, verification, twoFactor } });

  await seedIam(db);
  console.log('  Reference roles ready.');
  await seedTag(db);
  console.log('  Default tags ready.');

  const result = await seedDemoData({
    db,
    auth,
    playerCount: Number(arg('players') ?? 36),
    password: arg('password') ?? 'password123',
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
