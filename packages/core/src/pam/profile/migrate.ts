// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@blurifycom/core/server/migrate';

/** Apply the profile module migrations (idempotent: drizzle skips already-recorded ones). */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_profile',
    migrationsSchema: 'drizzle',
    // player.display_name GIN trgm index (substring search) needs the pg_trgm extension.
    extensions: ['pg_trgm'],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
