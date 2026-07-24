// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

// Before 0002_silent_skaar.sql existed, "at most one active (tag, player) assignment" was
// enforced only by a service-level pre-check SELECT, which could not close a genuine concurrent
// race (or an at-least-once redelivery of the same tagging event): two inserts could both pass
// the pre-check and land as duplicate active (removed_at IS NULL) rows for the same
// (tag_id, player_id) pair. 0002_silent_skaar.sql adds `player_tag_active_key`, a partial unique
// index that closes that race going forward - but on a database that already accumulated
// duplicates from before this fix, `CREATE UNIQUE INDEX` aborts outright. This statement
// soft-removes every duplicate active row except the earliest (by created_at) per (tag_id,
// player_id) pair before the migrator reaches 0002, using this table's normal soft-delete
// columns (see tag.service.ts's removePlayerTag) so the cleanup itself leaves an audit-visible
// trace. Guarded by `to_regclass` because `preSql` runs before EVERY pending migration, including
// 0000 (which creates `player_tag` in the first place) - on a fresh database the table doesn't
// exist yet, so the guard is a no-op there instead of an error. Idempotent thereafter too: once
// at most one active row remains per pair, `rn > 1` never matches again.
const DEDUPE_ACTIVE_PLAYER_TAG_SQL = `
DO $$
BEGIN
  IF to_regclass('public.player_tag') IS NOT NULL THEN
    WITH ranked AS (
      SELECT id, row_number() OVER (
        PARTITION BY tag_id, player_id ORDER BY created_at ASC
      ) AS rn
      FROM player_tag
      WHERE removed_at IS NULL
    )
    UPDATE player_tag
    SET removed_at = now(),
        removal_reason = 'duplicate active assignment cleaned up before unique index migration',
        removal_actor = 'scheduled'
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
  END IF;
END $$;
`;

/** Apply the tag module migrations (idempotent: drizzle skips already-recorded ones). */
export function migrate(databaseUrl?: string): Promise<void> {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_tag',
    migrationsSchema: 'drizzle',
    extensions: [],
    preSql: [DEDUPE_ACTIVE_PLAYER_TAG_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
