import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { seedDemoData, type SeedResult } from './seed-demo-data.js';
import { createAuth, DRIZZLE, type DrizzleDb, Container } from '@blurifycom/core/server';
import { seedIam } from '@blurifycom/core/iam/seed';
import { seedTag } from '@blurifycom/core/pam';
import { user, session, account, verification } from '@blurifycom/core/pam/schema/identity';

export type SeedMinimalOptions = {
  /** Keep small for fast tests. */
  playerCount?: number;
  admin?: { email: string; password: string; name: string };
};

/**
 * Seed a small, deterministic fixture: IAM reference roles + a demo fixture
 * (admin + a few players + wallets + games) for tests.
 *
 * better-auth's drizzle adapter resolves models from the db's relational schema
 * (`db._.fullSchema`), so we build a schema-aware connection just for auth -
 * passing the tables via the adapter's `schema` option instead would trigger
 * strict admin-plugin field checks (eg `banned`). The plain container db is used
 * for the direct table inserts (players, wallets, ...).
 */
export async function seedMinimal(
  container: Container,
  options: SeedMinimalOptions = {},
): Promise<SeedResult> {
  const drizzleSvc = container.get(DRIZZLE);
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('seedMinimal: DATABASE_URL is not set (boot the app first)');

  const authPool = new Pool({ connectionString: url });
  const authDb = drizzle(authPool, {
    schema: { user, session, account, verification },
    casing: 'snake_case',
  });
  const auth = createAuth({ db: authDb as unknown as DrizzleDb });

  try {
    await seedIam(drizzleSvc.db);
    await seedTag(drizzleSvc.db);
    return await seedDemoData({
      db: drizzleSvc.db,
      auth,
      playerCount: options.playerCount ?? 4,
      admin: options.admin ?? {
        email: 'admin@oss.dev',
        password: 'password123',
        name: 'Platform Admin',
      },
    });
  } finally {
    await authPool.end();
  }
}
