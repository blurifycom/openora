import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

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
