import { applyMigrations } from '@oss/testing';
import { seedDemoData } from '@oss/api-runtime';
import { createAuth } from '@oss/auth';
import { createDrizzleDb } from '@oss/db';
import { user, session, account, verification } from '@oss/modules/platform/identity/schema';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/oss_igaming';

// Runs once before the suite: migrate the database the running stack points at,
// then seed a deterministic fixture (admin@oss.dev + players + wallets + games).
export default async function globalSetup(): Promise<void> {
  await applyMigrations(DATABASE_URL);
  const db = createDrizzleDb(DATABASE_URL);
  const auth = createAuth({ db, schema: { user, session, account, verification } });
  await seedDemoData({
    db,
    auth,
    playerCount: 6,
    admin: { email: 'admin@oss.dev', password: 'password123', name: 'Platform Admin' },
  });
}
