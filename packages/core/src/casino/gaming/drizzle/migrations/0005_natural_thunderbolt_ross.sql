CREATE TABLE "game_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_category_game" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"category_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_provider" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"aggregator_vendor_id" text,
	"logo_url" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "is_active" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "aggregator" text;--> statement-breakpoint
ALTER TABLE "game_category_game" ADD CONSTRAINT "game_category_game_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_category_game" ADD CONSTRAINT "game_category_game_category_id_game_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."game_category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_category_slug_key" ON "game_category" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "game_category_game_key" ON "game_category_game" USING btree ("game_id","category_id");--> statement-breakpoint
CREATE INDEX "game_category_game_category_id_idx" ON "game_category_game" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_provider_slug_key" ON "game_provider" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "game_provider_aggregator_vendor_id_key" ON "game_provider" USING btree ("aggregator_vendor_id");--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_provider_id_game_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."game_provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_slug_key" ON "game" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "game_provider_id_idx" ON "game" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "game_aggregator_idx" ON "game" USING btree ("aggregator");
--> statement-breakpoint
-- Backfill (previously standalone 0004): the DDL above added game.slug /
-- game.provider_id / game.aggregator as nullable and left the legacy
-- game.provider / game.category text columns in place (expand-only, so old
-- releases keep working). The statements below resolve every pre-existing row
-- into the new shape; the trailing ALTERs enforce NOT NULL once no NULL
-- remains (see schema/index.ts).
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
--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "aggregator" SET NOT NULL;
