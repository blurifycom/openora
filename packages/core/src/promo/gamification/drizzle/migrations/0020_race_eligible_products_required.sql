ALTER TABLE "promo_race" ALTER COLUMN "eligible_products" DROP DEFAULT;--> statement-breakpoint
-- An empty list used to count every product; it now has to name them, so a race created before
-- keeps counting what it did.
UPDATE "promo_race" SET "eligible_products" = '{"casino","live-casino","sportsbook","pvp"}'
WHERE cardinality("eligible_products") = 0;--> statement-breakpoint
ALTER TABLE "promo_race" ADD CONSTRAINT "promo_race_eligible_products_set" CHECK (cardinality("promo_race"."eligible_products") > 0);
