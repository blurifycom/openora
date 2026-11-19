ALTER TABLE "promo_rakeback_accrual" DROP CONSTRAINT "promo_rakeback_accrual_settlement";--> statement-breakpoint
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
ALTER TABLE "promo_rakeback_accrual" ADD CONSTRAINT "promo_rakeback_accrual_settlement" CHECK (("promo_rakeback_accrual"."claim_id" is null OR "promo_rakeback_accrual"."status" = 'claimed')
        AND ("promo_rakeback_accrual"."status" = 'voided') = ("promo_rakeback_accrual"."void_reason" is not null));