import { fileURLToPath } from 'node:url';
import { TURNOVER_STAKE_STATES } from '@openora/core/contracts';
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
    // A deferred stake flips to counted when its round settles.
    'turnover_state',
  ],
  setOnceColumns: ['balance_after', 'real_share', 'turnover_contribution'],
  // A finished row cannot be reopened: a rejected withdrawal put back to `pending` would be
  // rejected and refunded a second time.
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

// An entry is the record of a requirement: it is priced once and only ever cleared.
const TURNOVER_ENTRY_SQL = appendOnlyTableSql('wallet_turnover_entry', {
  mutableColumns: ['status', 'cleared_at', 'cleared_by', 'clear_reason'],
  setOnceColumns: ['pivot_value', 'required', 'priced_at'],
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

// A baseline moved after the fact would hide any breach before it.
const BALANCE_BASELINE_SQL = appendOnlyTableSql('wallet_balance_baseline', { mutableColumns: [] });

// A stored answer that changed would answer a retry with something the first call never got.
const LEDGER_API_REQUEST_SQL = appendOnlyTableSql('ledger_api_request', { mutableColumns: [] });

// 0051's enum cast fails on any row still typed `tip`; refuse readably first. Keys on the enum
// still having the `tip` label, not on 0051's journal entry.
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
    // 0051 rewrites wallet_transaction twice under ACCESS EXCLUSIVE; wait on live traffic for
    // at most this long, then fail the deploy rather than stall every bet behind the lock.
    lockTimeout: '5s',
    postSql: [LEDGER_RECORD_SQL, BALANCE_BASELINE_SQL, LEDGER_API_REQUEST_SQL, TURNOVER_ENTRY_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
