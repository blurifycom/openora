import { fileURLToPath } from 'node:url';
import { appendOnlyTableSql, runMigrations } from '@openora/core/server/migrate';

const GAME_ROUND_RECORD_SQL = appendOnlyTableSql('game_round', {
  mutableColumns: ['status', 'bet_amount', 'win_amount', 'reversed_amount', 'ended_at'],
  setOnceColumns: ['wager_product', 'rtp'],
  terminal: {
    column: 'status',
    values: ['completed', 'cancelled'],
    growOnly: ['win_amount', 'reversed_amount'],
    growOnlyTotals: [['bet_amount', 'reversed_amount']],
  },
});

const GAME_LEDGER_VERSION_SQL = `CREATE SEQUENCE IF NOT EXISTS game_ledger_version_seq AS integer;
   CREATE OR REPLACE FUNCTION game_bump_ledger_version() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'INSERT'
       OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
       OR NEW.game_type IS DISTINCT FROM OLD.game_type
       OR NEW.wager_product IS DISTINCT FROM OLD.wager_product
       OR NEW.rtp IS DISTINCT FROM OLD.rtp THEN
       NEW.ledger_version := nextval('game_ledger_version_seq');
     ELSE
       NEW.ledger_version := OLD.ledger_version;
     END IF;
     RETURN NEW;
   END;
   $$;
   DROP TRIGGER IF EXISTS game_ledger_version ON game;
   CREATE TRIGGER game_ledger_version
     BEFORE INSERT OR UPDATE ON game
     FOR EACH ROW EXECUTE FUNCTION game_bump_ledger_version();`;

export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_gaming',
    migrationsSchema: 'drizzle',
    postSql: [GAME_ROUND_RECORD_SQL, GAME_LEDGER_VERSION_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
