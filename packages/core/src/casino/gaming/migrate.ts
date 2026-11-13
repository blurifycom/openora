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

// Every writer of `game`, importer overlays included, moves `ledger_version` exactly when a
// column `ledger_game` projects changes, and no writer can set it by hand. The projection keeps
// the highest version it has seen, so a redelivered or reordered `gaming.game.changed` is inert.
// One statement, so the trigger is never absent between the drop and the create.
const GAME_LEDGER_VERSION_SQL = `CREATE OR REPLACE FUNCTION game_bump_ledger_version() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     NEW.ledger_version := OLD.ledger_version + CASE
       WHEN NEW.provider_id IS DISTINCT FROM OLD.provider_id
         OR NEW.game_type IS DISTINCT FROM OLD.game_type THEN 1
       ELSE 0
     END;
     RETURN NEW;
   END;
   $$;
   DROP TRIGGER IF EXISTS game_ledger_version ON game;
   CREATE TRIGGER game_ledger_version
     BEFORE UPDATE ON game
     FOR EACH ROW EXECUTE FUNCTION game_bump_ledger_version();`;

/** Apply the gaming module migrations (idempotent: drizzle skips already-recorded ones). */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_gaming',
    migrationsSchema: 'drizzle',
    postSql: [GAME_ROUND_RECORD_SQL, GAME_LEDGER_VERSION_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
