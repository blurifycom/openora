// Uses Drizzle's generated migration journal, but executes one file per database transaction.
// PostgreSQL enum values cannot be used until the transaction that adds them has committed.
// Each migration set ships its compiled SQL in the package tarball (the per-module `drizzle/`
// dirs land in `dist/**` via copy-drizzle), so a consumer runs migrations straight from
// node_modules with no source checkout. Every module owns its own journal + tracking table and
// calls `runMigrations`; this file owns only the engine `outbox` set. See ADR-0022/0020/0027.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { Pool } from 'pg';

export type RunMigrationsOptions = {
  /** Absolute path to the drizzle migrations folder (the dir holding the .sql + meta/). */
  migrationsFolder: string;
  /** Tracking table; omit for drizzle's default `__drizzle_migrations`. */
  migrationsTable?: string;
  /** Tracking schema; omit for drizzle's default `drizzle`. */
  migrationsSchema?: string;
  /** Override the DB url; defaults to DATABASE_ADMIN_URL ?? DATABASE_URL. */
  databaseUrl?: string;
  /**
   * Postgres extensions to `CREATE EXTENSION IF NOT EXISTS` before applying. drizzle-kit can't
   * express extensions in schema, so a module whose index needs one (eg pg_trgm for a GIN
   * trgm index) declares it here instead of hand-editing a regenerated migration.
   */
  extensions?: string[];
  /**
   * Raw SQL statements to run, in order, before the migrator applies any pending migration.
   * Unlike `extensions` (a bare identifier interpolated into a fixed `CREATE EXTENSION`
   * template, hence the strict name check), each entry here is a full statement the caller is
   * trusted to have written safely - these are literal string constants in module source, never
   * user input. This is for data cleanup drizzle-kit has no way to generate because it isn't a
   * schema diff at all (eg deduping rows that violate a new constraint a pending migration is
   * about to add) - a module declares it here instead of hand-editing a regenerated migration,
   * same rationale as `extensions`, different problem shape.
   */
  preSql?: string[];
  /**
   * Raw SQL statements to run inside the transaction immediately before a pending migration.
   * Use this for data preservation that must see the schema created by an earlier migration
   * but must complete before the selected migration changes or drops that schema.
   */
  preMigrationSql?: (migration: MigrationMeta) => readonly string[];
};

function migrateUrl(override?: string): string {
  const url = override ?? process.env['DATABASE_ADMIN_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('Cannot run migrations: set DATABASE_URL (or DATABASE_ADMIN_URL).');
  }
  return url;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

type SqlClient = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
};

/**
 * Serializes migration runners for one journal. The lock is session-scoped, so
 * it remains held while each migration uses its own transaction connection.
 */
export async function withMigrationAdvisoryLock<T>(
  client: SqlClient,
  lockName: string,
  action: () => Promise<T>,
) {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
  try {
    return await action();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
  }
}

export async function applyMigrationsIndividually({
  migrations,
  apply,
}: {
  migrations: MigrationMeta[];
  apply: (migration: MigrationMeta) => Promise<void>;
}) {
  for (const migration of migrations) {
    await apply(migration);
  }
}

/** Apply one migration set against the admin connection. Idempotent: drizzle skips already-recorded migrations. */
export async function runMigrations(opts: RunMigrationsOptions) {
  const pool = new Pool({ connectionString: migrateUrl(opts.databaseUrl) });
  try {
    for (const ext of opts.extensions ?? []) {
      if (!/^[a-z0-9_]+$/.test(ext)) {
        throw new Error(`Invalid extension name: ${ext}`);
      }
      await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    for (const sql of opts.preSql ?? []) {
      await pool.query(sql);
    }
    const migrationsTable = opts.migrationsTable ?? '__drizzle_migrations';
    const migrationsSchema = opts.migrationsSchema ?? 'drizzle';
    const migrationConfig = {
      migrationsFolder: opts.migrationsFolder,
      migrationsTable,
      migrationsSchema,
    };
    const schema = quoteIdentifier(migrationsSchema);
    const table = quoteIdentifier(migrationsTable);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    const lockClient = await pool.connect();
    try {
      await withMigrationAdvisoryLock(
        lockClient,
        `${migrationsSchema}.${migrationsTable}`,
        async () => {
          const applied = await lockClient.query<{ hash: string }>(
            `SELECT hash FROM ${schema}.${table}`,
          );
          const appliedHashes = new Set(applied.rows.map(({ hash }) => hash));
          const pending = readMigrationFiles(migrationConfig).filter(
            (migration) => !appliedHashes.has(migration.hash),
          );
          await applyMigrationsIndividually({
            migrations: pending,
            apply: async (migration) => {
              const client = await pool.connect();
              try {
                await client.query('BEGIN');
                for (const statement of opts.preMigrationSql?.(migration) ?? []) {
                  await client.query(statement);
                }
                for (const statement of migration.sql) {
                  await client.query(statement);
                }
                await client.query(
                  `INSERT INTO ${schema}.${table} (hash, created_at) VALUES ($1, $2)`,
                  [migration.hash, migration.folderMillis],
                );
                await client.query('COMMIT');
              } catch (error) {
                await client.query('ROLLBACK');
                throw error;
              } finally {
                client.release();
              }
            },
          });
        },
      );
    } finally {
      lockClient.release();
    }
  } finally {
    await pool.end();
  }
}

/** Apply the engine `outbox` migration set (the only engine-owned table); domain modules ship their own `migrate`. */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./outbox/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_outbox',
    migrationsSchema: 'drizzle',
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
