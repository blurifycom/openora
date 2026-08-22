ALTER TABLE "user" ADD COLUMN "username" text;--> statement-breakpoint
DO $$
BEGIN
  CREATE TEMP TABLE legacy_display_name (user_id uuid PRIMARY KEY, display_name text) ON COMMIT DROP;
  -- Isolated module tests migrate identity without profile, so the legacy display
  -- name is only read when that table exists. EXECUTE keeps it out of the plan.
  IF to_regclass('player') IS NOT NULL THEN
    EXECUTE 'INSERT INTO legacy_display_name SELECT user_id, display_name FROM player';
  END IF;

  -- The first holder of a base handle keeps it; every later holder falls back to a
  -- form suffixed with its own user id, so allocation is globally unique in one pass
  -- rather than a per-row probe against the growing set of taken handles.
  WITH normalized AS (
    SELECT
      u.id,
      left(
        regexp_replace(
          lower(coalesce(nullif(l.display_name, ''), nullif(u.name, ''), 'player')),
          '[^a-z0-9_]+', '_', 'g'
        ),
        20
      ) AS base
    FROM "user" AS u
    LEFT JOIN legacy_display_name AS l ON l.user_id = u.id
    WHERE u.username IS NULL
  ), sanitized AS (
    SELECT id, CASE WHEN base IS NULL OR length(base) < 3 THEN 'player' ELSE base END AS base
    FROM normalized
  ), ranked AS (
    SELECT id, base, row_number() OVER (PARTITION BY base ORDER BY id) AS rank
    FROM sanitized
  )
  UPDATE "user" AS u
  SET username = CASE
    WHEN ranked.rank = 1 THEN ranked.base
    ELSE left(ranked.base, 7) || '_' || left(replace(u.id::text, '-', ''), 12)
  END
  FROM ranked
  WHERE u.id = ranked.id;
END $$;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_username_unique" ON "user" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "user_username_trgm_idx" ON "user" USING gin ("username" gin_trgm_ops);
