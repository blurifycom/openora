import { fileURLToPath } from 'node:url';
import { appendOnlyTableSql, runMigrations } from '@openora/core/server/migrate';

// The ledger is the financial transaction record, so it is append-only: no DELETE, and an UPDATE
// moves only a row's lifecycle (status, review fields), its provider references and balance_after
// once each is first known. Amount, type, currency, direction, ids, round ref and created_at
// never change. A data-fixing migration must disable the trigger itself, then re-enable it.
const LEDGER_RECORD_SQL = appendOnlyTableSql('wallet_transaction', {
  mutableColumns: [
    'status',
    'reviewed_by',
    'reviewed_at',
    'review_reason',
    'auto_approval_pivot_amount',
  ],
  setOnceColumns: ['provider_name', 'provider_ref_id', 'tx_hash', 'balance_after'],
});

// NOT VALID: enforces every new write without failing the migration on a balance already
// negative. Every debit is guarded by `amount >= requested`, so no legitimate flow goes below zero.
const NON_NEGATIVE_BALANCE_SQL = `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_balance_amount_non_negative') THEN
      ALTER TABLE wallet_balance
        ADD CONSTRAINT wallet_balance_amount_non_negative CHECK (amount >= 0) NOT VALID;
    END IF;
  END
  $$`;

export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_wallet',
    migrationsSchema: 'drizzle',
    postSql: [...LEDGER_RECORD_SQL, NON_NEGATIVE_BALANCE_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
