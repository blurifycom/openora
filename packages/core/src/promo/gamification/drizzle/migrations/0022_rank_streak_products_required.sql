ALTER TABLE "promo_rank_config" ALTER COLUMN "eligible_products" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "promo_streak_config" ALTER COLUMN "eligible_products" DROP DEFAULT;--> statement-breakpoint
-- An empty list used to count every product; it now has to name them, so a config saved before
-- keeps counting what it did.
UPDATE "promo_rank_config" SET "eligible_products" = '{"casino","live-casino","sportsbook","pvp"}'
WHERE cardinality("eligible_products") = 0;--> statement-breakpoint
UPDATE "promo_rank_config" SET "rakeback_eligible_products" = '{"casino","live-casino","sportsbook","pvp"}'
WHERE cardinality("rakeback_eligible_products") = 0;--> statement-breakpoint
UPDATE "promo_rank_config" SET "rank_challenge_eligible_products" = '{"casino","live-casino","sportsbook","pvp"}'
WHERE cardinality("rank_challenge_eligible_products") = 0;--> statement-breakpoint
UPDATE "promo_streak_config" SET "eligible_products" = '{"casino","live-casino","sportsbook","pvp"}'
WHERE cardinality("eligible_products") = 0;--> statement-breakpoint
ALTER TABLE "promo_rank_config" ADD CONSTRAINT "promo_rank_config_eligible_products_set" CHECK (cardinality("promo_rank_config"."eligible_products") > 0);--> statement-breakpoint
ALTER TABLE "promo_rank_config" ADD CONSTRAINT "promo_rank_config_rakeback_eligible_products_set" CHECK (cardinality("promo_rank_config"."rakeback_eligible_products") > 0);--> statement-breakpoint
ALTER TABLE "promo_rank_config" ADD CONSTRAINT "promo_rank_config_rank_challenge_eligible_products_set" CHECK (cardinality("promo_rank_config"."rank_challenge_eligible_products") > 0);--> statement-breakpoint
ALTER TABLE "promo_streak_config" ADD CONSTRAINT "promo_streak_config_eligible_products_set" CHECK (cardinality("promo_streak_config"."eligible_products") > 0);