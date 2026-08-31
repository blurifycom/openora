import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

/**
 * Apply the exchange-rate module migrations (idempotent: drizzle skips already-recorded ones).
 */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_exchange_rate',
    migrationsSchema: 'drizzle',
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
