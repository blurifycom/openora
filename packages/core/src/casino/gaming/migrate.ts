// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { appendOnlyTableSql, runMigrations } from '@openora/core/server/migrate';

const GAME_ROUND_RECORD_SQL = appendOnlyTableSql('game_round', {
  mutableColumns: ['status', 'bet_amount', 'win_amount', 'reversed_amount', 'ended_at'],
  // A settled round still takes late aggregator deltas (`accumulateExternalRound`), so its totals
  // stay writable but only upwards, and it cannot return to `active`. A stake the aggregator
  // reverses leaves `bet_amount` only by landing in `reversed_amount`, so the stake as first
  // placed (`bet_amount + reversed_amount`) is never lost from the record.
  terminal: {
    column: 'status',
    values: ['completed', 'cancelled'],
    growOnly: ['win_amount', 'reversed_amount'],
    growOnlyTotals: [['bet_amount', 'reversed_amount']],
  },
});

/** Apply the gaming module migrations (idempotent: drizzle skips already-recorded ones). */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_gaming',
    migrationsSchema: 'drizzle',
    postSql: [GAME_ROUND_RECORD_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
