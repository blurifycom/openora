// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

/** Apply the profile module migrations (idempotent: drizzle skips already-recorded ones). */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_profile',
    migrationsSchema: 'drizzle',
    // Migration 0000 still creates the display_name trigram index that 0003 later drops,
    // so a fresh database replaying the history needs the extension even though the
    // current schema has no trigram index of its own.
    extensions: ['pg_trgm'],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
