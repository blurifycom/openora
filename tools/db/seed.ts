#!/usr/bin/env node
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
