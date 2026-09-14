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
-- game.provider / game.category text columns in place. The statements below
-- resolve every pre-existing row into the new shape, install the legacy-insert
-- triggers so the previous release can keep writing during a rolling deploy,
-- and only then enforce NOT NULL (see schema/index.ts).
--
-- Truncating after the trim would let a name longer than max_length end the
-- slug on a '-', which CatalogSlugSchema rejects. Returns NULL when the source
-- has no alphanumerics; every caller supplies its own fallback.
CREATE OR REPLACE FUNCTION "game_catalog_slugify"(source text, max_length int)
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
-- Each probe is its own statement, so it sees the rows the caller inserted before it.
CREATE OR REPLACE FUNCTION "game_catalog_unique_slug"(target regclass, source text, fallback text)
RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE
	base text := COALESCE("game_catalog_slugify"(source, 60), fallback);
	candidate text := base;
	attempt int := 1;
	taken boolean;
BEGIN
	LOOP
		EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE "slug" = $1)', target)
			INTO taken USING candidate;
		EXIT WHEN NOT taken;
		attempt := attempt + 1;
		candidate := "game_catalog_slugify"(base, greatest(1, 63 - length(attempt::text)))
			|| '-' || attempt;
	END LOOP;
	RETURN candidate;
END
$fn$;--> statement-breakpoint
DO $do$
DECLARE
	source record;
BEGIN
	FOR source IN
		SELECT DISTINCT COALESCE("provider", 'Unknown') AS "name" FROM "game" ORDER BY 1
	LOOP
		INSERT INTO "game_provider" ("slug", "name", "is_active", "updated_at")
		VALUES (
			"game_catalog_unique_slug"('game_provider', source."name", 'provider-' || left(md5(source."name"), 8)),
			source."name",
			true,
			now()
		);
	END LOOP;
END
$do$;--> statement-breakpoint
DO $do$
DECLARE
	source record;
BEGIN
	FOR source IN
		SELECT DISTINCT COALESCE("category", 'Uncategorized') AS "name" FROM "game" ORDER BY 1
	LOOP
		INSERT INTO "game_category" ("slug", "name", "updated_at")
		VALUES (
			"game_catalog_unique_slug"('game_category', source."name", 'category-' || left(md5(source."name"), 8)),
			source."name",
			now()
		);
	END LOOP;
END
$do$;--> statement-breakpoint
INSERT INTO "game_category_game" ("game_id", "category_id")
SELECT "g"."id", "c"."id" FROM "game" "g"
JOIN "game_category" "c" ON "c"."name" = COALESCE("g"."category", 'Uncategorized');--> statement-breakpoint
DO $do$
DECLARE
	source record;
BEGIN
	FOR source IN
		SELECT "id", "name", COALESCE("provider", 'Unknown') AS "provider_name"
		FROM "game" ORDER BY "id"
	LOOP
		UPDATE "game" SET
			"slug" = "game_catalog_unique_slug"('game', source."name", 'game-' || left(source."id"::text, 8)),
			"provider_id" = (SELECT "id" FROM "game_provider" WHERE "name" = source."provider_name"),
			"aggregator" = 'direct'
		WHERE "id" = source."id";
	END LOOP;
END
$do$;--> statement-breakpoint
INSERT INTO "game_provider_aggregator_mapping" ("provider_id", "aggregator", "vendor_id")
SELECT "p"."id", 'direct', "p"."slug" FROM "game_provider" "p"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Rolling-deploy compatibility: an instance still on the previous release inserts
-- the legacy shape (name, provider, category) and cannot populate slug, provider_id
-- or aggregator. BEFORE INSERT derives them exactly as the backfill above does, so
-- the NOT NULL below holds for old writers too. New code always sets all three, so
-- the WHEN clause keeps these triggers off its path. Drop both triggers and the
-- three functions together with the legacy columns in the follow-up contract migration.
CREATE OR REPLACE FUNCTION "game_legacy_insert"()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
	provider_name text := COALESCE(NEW."provider", 'Unknown');
BEGIN
	IF NEW."provider_id" IS NULL THEN
		SELECT "id" INTO NEW."provider_id" FROM "game_provider"
		WHERE "name" = provider_name ORDER BY "created_at", "id" LIMIT 1;
	END IF;
	IF NEW."provider_id" IS NULL THEN
		INSERT INTO "game_provider" ("slug", "name", "is_active", "updated_at")
		VALUES (
			"game_catalog_unique_slug"('game_provider', provider_name, 'provider-' || left(md5(provider_name), 8)),
			provider_name,
			true,
			now()
		)
		RETURNING "id" INTO NEW."provider_id";
	END IF;
	NEW."aggregator" := COALESCE(NEW."aggregator", 'direct');
	NEW."slug" := COALESCE(
		NEW."slug",
		"game_catalog_unique_slug"('game', NEW."name", 'game-' || left(NEW."id"::text, 8))
	);
	INSERT INTO "game_provider_aggregator_mapping" ("provider_id", "aggregator", "vendor_id")
	SELECT "id", NEW."aggregator", "slug" FROM "game_provider" WHERE "id" = NEW."provider_id"
	ON CONFLICT DO NOTHING;
	RETURN NEW;
END
$fn$;--> statement-breakpoint
CREATE TRIGGER "game_legacy_insert" BEFORE INSERT ON "game"
FOR EACH ROW WHEN (NEW."slug" IS NULL OR NEW."provider_id" IS NULL OR NEW."aggregator" IS NULL)
EXECUTE FUNCTION "game_legacy_insert"();--> statement-breakpoint
-- The category link needs the committed game id for its foreign key, so it runs
-- AFTER INSERT. Only the previous release writes game.category.
CREATE OR REPLACE FUNCTION "game_legacy_category_link"()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
	linked_category_id uuid;
BEGIN
	SELECT "id" INTO linked_category_id FROM "game_category"
	WHERE "name" = NEW."category" ORDER BY "created_at", "id" LIMIT 1;
	IF linked_category_id IS NULL THEN
		INSERT INTO "game_category" ("slug", "name", "updated_at")
		VALUES (
			"game_catalog_unique_slug"('game_category', NEW."category", 'category-' || left(md5(NEW."category"), 8)),
			NEW."category",
			now()
		)
		RETURNING "id" INTO linked_category_id;
	END IF;
	INSERT INTO "game_category_game" ("game_id", "category_id")
	VALUES (NEW."id", linked_category_id)
	ON CONFLICT DO NOTHING;
	RETURN NULL;
END
$fn$;--> statement-breakpoint
CREATE TRIGGER "game_legacy_category_link" AFTER INSERT ON "game"
FOR EACH ROW WHEN (NEW."category" IS NOT NULL)
EXECUTE FUNCTION "game_legacy_category_link"();--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "aggregator" SET NOT NULL;
