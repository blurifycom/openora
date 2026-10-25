// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { appendOnlyTableSql, runMigrations } from '@openora/core/server/migrate';

// game_round is the game play record, so it is append-only: no DELETE, and an UPDATE moves only
// what a round accumulates or settles (status, amounts, end time). game_id, user_id, currency,
// started_at and external_round_id never change; remapping a round to another game is a
// data-fixing migration that disables the trigger itself, then re-enables it.
const GAME_ROUND_RECORD_SQL = appendOnlyTableSql('game_round', {
  mutableColumns: ['status', 'bet_amount', 'win_amount', 'ended_at'],
});

/** Apply the gaming module migrations (idempotent: drizzle skips already-recorded ones). */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_gaming',
    migrationsSchema: 'drizzle',
    postSql: GAME_ROUND_RECORD_SQL,
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
