CREATE TABLE "game_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
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
	"logo_url" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_provider_aggregator_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"aggregator" text NOT NULL,
	"vendor_id" text NOT NULL
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
ALTER TABLE "game_provider_aggregator_mapping" ADD CONSTRAINT "game_provider_aggregator_mapping_provider_id_game_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."game_provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_provider_aggregator_mapping_provider_aggregator_key" ON "game_provider_aggregator_mapping" USING btree ("provider_id","aggregator");--> statement-breakpoint
CREATE UNIQUE INDEX "game_provider_aggregator_mapping_aggregator_vendor_id_key" ON "game_provider_aggregator_mapping" USING btree ("aggregator","vendor_id");--> statement-breakpoint
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
--
-- Truncating after the trim would let a name longer than max_length end the
-- slug on a '-', which CatalogSlugSchema rejects. Returns NULL when the source
-- has no alphanumerics; every caller supplies its own fallback.
CREATE OR REPLACE FUNCTION pg_temp.openora_slugify(source text, max_length int)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
	SELECT NULLIF(
		regexp_replace(
			left(lower(regexp_replace(source, '[^a-zA-Z0-9]+', '-', 'g')), max_length),
			'(^-+|-+$)', '', 'g'
		),
		''
	)
$fn$;--> statement-breakpoint
-- The dedupe suffix is probed rather than taken from a window function:
-- 'book-of-ra-2' is itself the natural slug of "Book of Ra 2", so a blind
-- suffix collides with the already-live unique index and aborts the migration.
DO $do$
DECLARE
	source record;
	base text;
	candidate text;
	attempt int;
BEGIN
	FOR source IN
		SELECT DISTINCT COALESCE("provider", 'Unknown') AS "name" FROM "game" ORDER BY 1
	LOOP
		base := COALESCE(
			pg_temp.openora_slugify(source."name", 60),
			'provider-' || left(md5(source."name"), 8)
		);
		candidate := base;
		attempt := 1;
		WHILE EXISTS (SELECT 1 FROM "game_provider" WHERE "slug" = candidate) LOOP
			attempt := attempt + 1;
			candidate := pg_temp.openora_slugify(base, greatest(1, 63 - length(attempt::text)))
				|| '-' || attempt;
		END LOOP;
		INSERT INTO "game_provider" ("slug", "name", "is_active", "updated_at")
		VALUES (candidate, source."name", true, now());
	END LOOP;
END
$do$;--> statement-breakpoint
DO $do$
DECLARE
	source record;
	base text;
	candidate text;
	attempt int;
BEGIN
	FOR source IN
		SELECT DISTINCT COALESCE("category", 'Uncategorized') AS "name" FROM "game" ORDER BY 1
	LOOP
		base := COALESCE(
			pg_temp.openora_slugify(source."name", 60),
			'category-' || left(md5(source."name"), 8)
		);
		candidate := base;
		attempt := 1;
		WHILE EXISTS (SELECT 1 FROM "game_category" WHERE "slug" = candidate) LOOP
			attempt := attempt + 1;
			candidate := pg_temp.openora_slugify(base, greatest(1, 63 - length(attempt::text)))
				|| '-' || attempt;
		END LOOP;
		INSERT INTO "game_category" ("slug", "name", "updated_at")
		VALUES (candidate, source."name", now());
	END LOOP;
END
$do$;--> statement-breakpoint
INSERT INTO "game_category_game" ("game_id", "category_id")
SELECT "g"."id", "c"."id" FROM "game" "g"
JOIN "game_category" "c" ON "c"."name" = COALESCE("g"."category", 'Uncategorized');--> statement-breakpoint
DO $do$
DECLARE
	source record;
	base text;
	candidate text;
	attempt int;
BEGIN
	FOR source IN
		SELECT "id", "name", COALESCE("provider", 'Unknown') AS "provider_name"
		FROM "game" ORDER BY "id"
	LOOP
		base := COALESCE(
			pg_temp.openora_slugify(source."name", 60),
			'game-' || left(source."id"::text, 8)
		);
		candidate := base;
		attempt := 1;
		WHILE EXISTS (SELECT 1 FROM "game" WHERE "slug" = candidate) LOOP
			attempt := attempt + 1;
			candidate := pg_temp.openora_slugify(base, greatest(1, 63 - length(attempt::text)))
				|| '-' || attempt;
		END LOOP;
		UPDATE "game" SET
			"slug" = candidate,
			"provider_id" = (SELECT "id" FROM "game_provider" WHERE "name" = source."provider_name"),
			"aggregator" = 'direct'
		WHERE "id" = source."id";
	END LOOP;
END
$do$;--> statement-breakpoint
INSERT INTO "game_provider_aggregator_mapping" ("provider_id", "aggregator", "vendor_id")
SELECT "p"."id", 'direct', "p"."slug" FROM "game_provider" "p"
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP FUNCTION pg_temp.openora_slugify(text, int);--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "aggregator" SET NOT NULL;
