import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';

const DEFAULT_TEST_URL = 'postgres://postgres:postgres@localhost:5432/oss_igaming_test';

/**
 * Resolve `@oss/db`'s migrations folder regardless of where this package is
 * installed (workspace or linked into a consumer). drizzle-kit writes them to
 * `drizzle/migrations` next to the db package's drizzle.config.ts.
 */
function migrationsFolder(): string {
  // `@oss/db` doesn't expose ./package.json via its exports map, so resolve its
  // entry instead and walk up until we find the drizzle migrations directory.
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve('@oss/db'));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'drizzle/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate @oss/db drizzle/migrations folder');
}

/**
 * Apply the platform migrations to the database at `url`. Idempotent (drizzle
 * tracks applied migrations). Used by both the integration harness and the E2E
 * global-setup. The database must already exist.
 */
export async function applyMigrations(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: migrationsFolder() });
  } finally {
    await pool.end();
  }
}

export interface TestDb {
  /** The connection string the app under test must use. */
  url: string;
  /** Delete all rows from every table (keeps the schema). Call between suites. */
  truncateAll(): Promise<void>;
  /** Close the migration pool. Call once in global teardown. */
  dispose(): Promise<void>;
}

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
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder: migrationsFolder() });

  return {
    url,
    async truncateAll() {
      const rows = await db.execute<{ tablename: string }>(sql`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_drizzle%'
      `);
      const tables = rows.rows.map((r) => `"public"."${r.tablename}"`);
      if (tables.length === 0) return;
      await db.execute(sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`));
    },
    async dispose() {
      await pool.end();
    },
  };
}
