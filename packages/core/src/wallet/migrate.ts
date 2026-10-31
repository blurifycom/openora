import { fileURLToPath } from 'node:url';
import { appendOnlyTableSql, runMigrations } from '@openora/core/server/migrate';

// Provider references stay updatable: a vendor that reports a different id on completion must
// not block the money update.
const LEDGER_RECORD_SQL = appendOnlyTableSql('wallet_transaction', {
  mutableColumns: [
    'status',
    'reviewed_by',
    'reviewed_at',
    'review_reason',
    'auto_approval_pivot_amount',
    'provider_name',
    'provider_ref_id',
    'tx_hash',
  ],
  setOnceColumns: ['balance_after', 'real_share'],
  // A finished row cannot be reopened: a rejected withdrawal put back to `pending` would be
  // rejected and refunded a second time.
  terminal: {
    column: 'status',
    values: ['completed', 'failed', 'rejected', 'cancelled', 'refunded'],
  },
});

export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_wallet',
    migrationsSchema: 'drizzle',
    postSql: [LEDGER_RECORD_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
