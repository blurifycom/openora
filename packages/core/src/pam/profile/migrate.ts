// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

/** Apply the profile module migrations (idempotent: drizzle skips already-recorded ones). */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_profile',
    migrationsSchema: 'drizzle',
    // player.display_name GIN trgm index (substring search) needs the pg_trgm extension.
    extensions: ['pg_trgm'],
    // The generated identity migration adds nullable user.username + its partial
    // unique index. Profile runs after identity in the shipped plugin order, so
    // the legacy display name is available here to backfill players safely.
    postSql: [
      `
        DO $$
        BEGIN
          -- Isolated module tests can migrate profile without identity. The
          -- shipped plugin order always has this column before the backfill.
          IF to_regclass('"user"') IS NOT NULL
            AND to_regclass('player') IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM pg_attribute
              WHERE attrelid = to_regclass('"user"')
                AND attname = 'username'
                AND NOT attisdropped
            )
          THEN
        WITH normalized AS (
          SELECT
            u.id,
            left(
              nullif(
                lower(regexp_replace(coalesce(nullif(p.display_name, ''), nullif(u.name, ''), 'player'), '[^a-zA-Z0-9_]+', '_', 'g')),
                ''
              ),
              20
            ) AS normalized_username
          FROM "user" AS u
          LEFT JOIN player AS p ON p.user_id = u.id
          WHERE u.role = 'player' AND u.username IS NULL
        ), candidates AS (
          SELECT
            id,
            CASE
              WHEN normalized_username IS NULL OR length(normalized_username) < 3
                THEN left('player_' || coalesce(normalized_username, ''), 20)
              ELSE normalized_username
            END AS base_username
          FROM normalized
        ), ranked AS (
          SELECT
            id,
            base_username,
            row_number() OVER (PARTITION BY base_username ORDER BY id) AS collision_suffix
          FROM candidates
        )
        UPDATE "user" AS u
        SET username = CASE
          WHEN collision_suffix = 1 THEN base_username
          ELSE left(base_username, 20 - length(collision_suffix::text) - 1) || '_' || collision_suffix::text
        END
        FROM ranked
        WHERE u.id = ranked.id
          ;
          END IF;
        END $$;
      `,
    ],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
