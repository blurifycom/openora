-- 0003 added game.slug / game.provider_id / game.aggregator as nullable and left
-- the legacy game.provider / game.category text columns in place (expand-only, so old
-- releases keep working). This migration resolves every pre-existing row into the new
-- shape; 0005 enforces NOT NULL once no NULL remains (see schema/index.ts).
--
-- Slug derivation: kebab-case of the legacy string, truncated to 60 chars so the
-- de-duplication suffix below stays inside the 64-char catalog limit. Collisions
-- (two games named 'Roulette', or 'Acme' vs 'ACME' as providers) resolve to
-- '<base>-<n>' by row order; the suffix applies per colliding group, never globally.
-- A blank derivation falls back to '<kind>-<md5>' (providers/categories) or the row
-- id (games), so no input can produce an empty slug.
--
-- Backfilled providers stay active (is_active = true): every legacy row predates
-- curation and was player-visible, so deactivating them here would silently
-- unpublish the catalog. New providers keep the schema default (false) and enter
-- through curation instead.
--
-- A legacy game whose provider string is NULL (only possible if something nulled it
-- after the 0003 relax) resolves to an 'Unknown' provider rather than failing the
-- whole migration; likewise for a NULL category ('Uncategorized').
INSERT INTO "game_provider" ("slug", "name", "is_active", "updated_at")
SELECT
	CASE WHEN "s"."rn" = 1 THEN "s"."base" ELSE "s"."base" || '-' || "s"."rn" END,
	"s"."provider",
	true,
	now()
FROM (
	SELECT
		"b"."provider" AS "provider",
		"b"."base" AS "base",
		ROW_NUMBER() OVER (PARTITION BY "b"."base" ORDER BY "b"."provider") AS "rn"
	FROM (
		SELECT DISTINCT
			COALESCE("legacy"."provider", 'Unknown') AS "provider",
			COALESCE(
				NULLIF(left(lower(regexp_replace(regexp_replace(COALESCE("legacy"."provider", 'Unknown'), '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g')), 60), ''),
				'provider-' || left(md5(COALESCE("legacy"."provider", 'Unknown')), 8)
			) AS "base"
		FROM "game" "legacy"
	) "b"
) "s";--> statement-breakpoint
INSERT INTO "game_category" ("slug", "name", "updated_at")
SELECT
	CASE WHEN "s"."rn" = 1 THEN "s"."base" ELSE "s"."base" || '-' || "s"."rn" END,
	"s"."category",
	now()
FROM (
	SELECT
		"b"."category" AS "category",
		"b"."base" AS "base",
		ROW_NUMBER() OVER (PARTITION BY "b"."base" ORDER BY "b"."category") AS "rn"
	FROM (
		SELECT DISTINCT
			COALESCE("legacy"."category", 'Uncategorized') AS "category",
			COALESCE(
				NULLIF(left(lower(regexp_replace(regexp_replace(COALESCE("legacy"."category", 'Uncategorized'), '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g')), 60), ''),
				'category-' || left(md5(COALESCE("legacy"."category", 'Uncategorized')), 8)
			) AS "base"
		FROM "game" "legacy"
	) "b"
) "s";--> statement-breakpoint
INSERT INTO "game_category_game" ("game_id", "category_id")
SELECT "g"."id", "c"."id" FROM "game" "g"
JOIN "game_category" "c" ON "c"."name" = COALESCE("g"."category", 'Uncategorized');--> statement-breakpoint
UPDATE "game" "g"
SET "slug" = "s"."slug", "provider_id" = "p"."id", "aggregator" = 'direct'
FROM (
	SELECT
		"b"."id" AS "id",
		"b"."provider" AS "provider",
		CASE WHEN "b"."rn" = 1 THEN "b"."base" ELSE "b"."base" || '-' || "b"."rn" END AS "slug"
	FROM (
		SELECT
			"row"."id" AS "id",
			COALESCE("row"."provider", 'Unknown') AS "provider",
			COALESCE(
				NULLIF(left(lower(regexp_replace(regexp_replace("row"."name", '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g')), 60), ''),
				'game-' || left("row"."id"::text, 8)
			) AS "base",
			ROW_NUMBER() OVER (
				PARTITION BY COALESCE(
					NULLIF(left(lower(regexp_replace(regexp_replace("row"."name", '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g')), 60), ''),
					'game-' || left("row"."id"::text, 8)
				)
				ORDER BY "row"."id"
			) AS "rn"
		FROM "game" "row"
	) "b"
) "s"
JOIN "game_provider" "p" ON "p"."name" = "s"."provider"
WHERE "g"."id" = "s"."id";
