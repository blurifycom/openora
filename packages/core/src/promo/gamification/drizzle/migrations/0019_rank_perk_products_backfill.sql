-- 0018 gave rakeback and the rank challenge a product list defaulting to the casino products, so a
-- ladder configured before it would quietly stop paying on sportsbook. An empty list counts every
-- product, which is what those ladders did. A list an operator has already changed is kept.
UPDATE "promo_rank_config" SET "rakeback_eligible_products" = '{}'
WHERE "rakeback_eligible_products" = '{"casino","live-casino","pvp"}';--> statement-breakpoint
UPDATE "promo_rank_config" SET "rank_challenge_eligible_products" = '{}'
WHERE "rank_challenge_eligible_products" = '{"casino","live-casino","pvp"}';
