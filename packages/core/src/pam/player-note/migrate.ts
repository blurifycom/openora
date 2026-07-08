import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

export function migrate(databaseUrl?: string): Promise<void> {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_player_note',
    migrationsSchema: 'drizzle',
    extensions: [],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
