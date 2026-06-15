import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { seedDemoData, type SeedResult } from '@oss/api-runtime';
import { createAuth } from '@oss/auth';
import { DRIZZLE, type DrizzleDb } from '@oss/db';
import type { Container } from '@oss/core';
import { user, session, account, verification } from '@oss/pam/schema/identity';

export type SeedMinimalOptions = {
  /** Number of demo players to create. Keep small for fast tests. Default 4. */
  playerCount?: number;
  admin?: { email: string; password: string; name: string };
};

/**
 * Seed a small, deterministic fixture (admin + a few players + wallets + games).
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
  const authDb = drizzle(authPool, { schema: { user, session, account, verification } });
  const auth = createAuth({ db: authDb as unknown as DrizzleDb });

  try {
    return await seedDemoData({
      // Seed is a cross-tenant system path - use the BYPASSRLS admin db so RLS
      // does not filter out its writes/reads (ADR-0018). Outside a request there
      // is no tenant GUC, so the RLS app path would see zero rows on scoped tables.
      db: drizzleSvc.adminDb,
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
