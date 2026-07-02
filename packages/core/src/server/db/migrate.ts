// Uses drizzle-orm's migrator, NOT drizzle-kit (dev-only authoring tool). Each migration
// set ships its compiled SQL in the package tarball (the per-module `drizzle/` dirs land in
// `dist/**` via copy-drizzle), so a consumer runs migrations straight from node_modules with
// no source checkout. Every module owns its own journal + tracking table and calls
// `runMigrations`; this file owns only the engine `outbox` set. See ADR-0022/0020/0027.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
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

/** Apply one migration set against the admin connection. Idempotent: drizzle skips already-recorded migrations. */
export async function runMigrations(opts: RunMigrationsOptions) {
  const pool = new Pool({ connectionString: migrateUrl(opts.databaseUrl) });
  try {
    for (const ext of opts.extensions ?? []) {
      if (!/^[a-z0-9_]+$/.test(ext)) throw new Error(`Invalid extension name: ${ext}`);
      await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    const db = drizzle(pool, { casing: 'snake_case' });
    await drizzleMigrate(db, {
      migrationsFolder: opts.migrationsFolder,
      ...(opts.migrationsTable ? { migrationsTable: opts.migrationsTable } : {}),
      ...(opts.migrationsSchema ? { migrationsSchema: opts.migrationsSchema } : {}),
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
