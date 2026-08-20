import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

const LEGACY_BALANCE_BACKFILL_SQL = `
  INSERT INTO "wallet_balance" ("wallet_id", "currency", "amount")
  SELECT "id", upper("currency"), "balance"
  FROM "wallet"
  ON CONFLICT ("wallet_id", "currency") DO UPDATE
  SET "amount" = "wallet_balance"."amount" + EXCLUDED."amount", "updated_at" = now()
`;

function preMigrationSql({ sql }: { sql: string[] }): readonly string[] {
  return sql.some((statement) => statement.includes('ALTER TABLE "wallet" DROP COLUMN "balance"'))
    ? [LEGACY_BALANCE_BACKFILL_SQL]
    : [];
}

export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_wallet',
    migrationsSchema: 'drizzle',
    preMigrationSql,
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
