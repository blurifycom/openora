// Uses drizzle-orm's migrator, NOT drizzle-kit (dev-only authoring tool). Each migration
// set ships its compiled SQL in the package tarball (`files: ["drizzle"]`), so a
// consumer runs migrations straight from node_modules with no source checkout.
// The core history is shared by every core add-on; gated add-ons ship their own
// `migrate` that calls `runMigrations` with their own tracking table. See ADR-0022/0020.
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
};

function migrateUrl(override?: string): string {
  const url = override ?? process.env['DATABASE_ADMIN_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('Cannot run migrations: set DATABASE_URL (or DATABASE_ADMIN_URL).');
  }
  return url;
}

/** Apply one migration set against the admin connection. Idempotent: drizzle skips already-recorded migrations. */
export async function runMigrations(opts: RunMigrationsOptions): Promise<void> {
  const pool = new Pool({ connectionString: migrateUrl(opts.databaseUrl) });
  try {
    const db = drizzle(pool);
    await drizzleMigrate(db, {
      migrationsFolder: opts.migrationsFolder,
      ...(opts.migrationsTable ? { migrationsTable: opts.migrationsTable } : {}),
      ...(opts.migrationsSchema ? { migrationsSchema: opts.migrationsSchema } : {}),
    });
  } finally {
    await pool.end();
  }
}

/** Core migration set shared by all core add-ons, tracked in drizzle's default `__drizzle_migrations`. */
export function migrate(databaseUrl?: string): Promise<void> {
  return runMigrations({
    // compiled to core/dist/server/db/migrate.js; migrations ship at the package root
    // (core/drizzle/migrations), so climb out of dist/server/db.
    migrationsFolder: fileURLToPath(new URL('../../../drizzle/migrations', import.meta.url)),
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
