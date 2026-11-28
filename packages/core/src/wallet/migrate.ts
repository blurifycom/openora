import { fileURLToPath } from 'node:url';
import { TURNOVER_STAKE_STATES } from '@openora/core/contracts';
import { appendOnlyTableSql, runMigrations } from '@openora/core/server/migrate';

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
    'turnover_state',
  ],
  setOnceColumns: ['balance_after', 'real_share', 'turnover_contribution'],
  terminal: {
    column: 'status',
    values: ['completed', 'failed', 'rejected', 'cancelled', 'refunded'],
  },
  transitions: [
    {
      column: 'turnover_state',
      allowed: [
        ...TURNOVER_STAKE_STATES.map((state) => [null, state] as const),
        ['deferred', 'counted'],
      ],
    },
  ],
});

const TURNOVER_ENTRY_SQL = appendOnlyTableSql('wallet_turnover_entry', {
  mutableColumns: ['status'],
  setOnceColumns: [
    'pivot_value',
    'required',
    'priced_at',
    'cleared_at',
    'cleared_by',
    'clear_reason',
  ],
  transitions: [
    {
      column: 'status',
      allowed: [
        ['pending', 'counted'],
        ['pending', 'cleared'],
        ['counted', 'cleared'],
      ],
    },
  ],
});

const BALANCE_BASELINE_SQL = appendOnlyTableSql('wallet_balance_baseline', { mutableColumns: [] });

const LEDGER_API_REQUEST_SQL = appendOnlyTableSql('ledger_api_request', { mutableColumns: [] });

const REFUSE_TIP_ROWS_SQL = `
DO $$
DECLARE
  tip_rows bigint;
BEGIN
  IF to_regclass('wallet_transaction') IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'wallet_transaction_type' AND e.enumlabel = 'tip'
  ) THEN
    RETURN;
  END IF;
  SELECT count(*) INTO tip_rows FROM wallet_transaction WHERE type::text = 'tip';
  IF tip_rows > 0 THEN
    RAISE EXCEPTION 'wallet migration refused: % wallet_transaction row(s) have type ''tip''. This release removes the tip transaction type and ledger rows are immutable. On a development or test database, reset it before upgrading; on a database holding real money, stay on the previous release.', tip_rows;
  END IF;
END $$;
`;

export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_wallet',
    migrationsSchema: 'drizzle',
    preSql: [REFUSE_TIP_ROWS_SQL],
    lockTimeout: '5s',
    postSql: [LEDGER_RECORD_SQL, BALANCE_BASELINE_SQL, LEDGER_API_REQUEST_SQL, TURNOVER_ENTRY_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
