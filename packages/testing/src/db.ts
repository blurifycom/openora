import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
// Every module owns its own migration tracking table + history (ADR-0027) - a full
// test DB must apply all of them or integration tests hit "relation does not exist".
// `server/migrate` covers only the engine-owned `outbox` table; everything else is a
// domain module. Keep this list in sync with `packages/core/src/**/migrate.ts`.
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateTag } from '@openora/core/pam/migrate/tag';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import { migrate as migrateIam } from '@openora/core/iam/migrate';
import { migrate as migrateCms } from '@openora/core/cms/migrate';
import { migrate as migrateCompliance } from '@openora/core/compliance/migrate';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { migrate as migrateLobby } from '@openora/core/casino/migrate/lobby';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import { migrate as migrateChatCommands } from '@openora/core/engagement/migrate/chat-commands';
import { migrate as migrateNotifications } from '@openora/core/engagement/migrate/notifications';
import { migrate as migrateSocial } from '@openora/core/engagement/migrate/social';
import { migrate as migrateExchangeRate } from '@openora/core/fx/migrate/exchange-rate';

const DEFAULT_TEST_URL = 'postgres://postgres:postgres@localhost:5432/oss_igaming_test';

async function applyAllMigrations(url: string): Promise<void> {
  // No cross-module FKs (db-conventions), so order is only for readability.
  await migrateOutbox(url);
  await migrateIdentity(url);
  await migrateProfile(url);
  await migrateTag(url);
  await migrateAudit(url);
  await migrateIam(url);
  await migrateCms(url);
  await migrateCompliance(url);
  await migrateWallet(url);
  await migrateGaming(url);
  await migrateLobby(url);
  await migrateChat(url);
  await migrateChatCommands(url);
  await migrateNotifications(url);
  await migrateSocial(url);
  await migrateExchangeRate(url);
}

export async function applyMigrations(url: string): Promise<void> {
  await applyAllMigrations(url);
}

export type TestDb = {
  /** The connection string the app under test must use. */
  url: string;
  /** Delete all rows from every table (keeps the schema). Call between suites. */
  truncateAll(): Promise<void>;
  /** Close the migration pool. Call once in global teardown. */
  dispose(): Promise<void>;
};

/**
 * Prepare a real Postgres test database: apply the platform migrations, then
 * hand back a `url` to point the app at plus truncate/dispose helpers.
 *
 * The database must already exist (CI creates it; locally run
 * `createdb oss_igaming_test` or the `db:test:setup` script). Override the
 * target with `TEST_DATABASE_URL`.
 */
export async function setupTestDb(): Promise<TestDb> {
  const url = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_URL;
  await applyAllMigrations(url);

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { casing: 'snake_case' });

  return {
    url,
    async truncateAll() {
      const rows = await db.execute<{ tablename: string }>(sql`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_drizzle%'
      `);
      const tables = rows.rows.map((r) => `"public"."${r.tablename}"`);
      if (tables.length === 0) {
        return;
      }
      await db.execute(sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`));
    },
    async dispose() {
      await pool.end();
    },
  };
}
