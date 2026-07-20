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
    const latest = await pool.query<{ created_at: string | number }>(
      `SELECT created_at FROM ${schema}.${table} ORDER BY created_at DESC LIMIT 1`,
    );
    const lastAppliedAt = Number(latest.rows[0]?.created_at ?? 0);
    const pending = readMigrationFiles(migrationConfig).filter(
      (migration) => migration.folderMillis > lastAppliedAt,
    );
    await applyMigrationsIndividually({
      migrations: pending,
      apply: async (migration) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const statement of migration.sql) {
            await client.query(statement);
          }
          await client.query(`INSERT INTO ${schema}.${table} (hash, created_at) VALUES ($1, $2)`, [
            migration.hash,
            migration.folderMillis,
          ]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    });
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
