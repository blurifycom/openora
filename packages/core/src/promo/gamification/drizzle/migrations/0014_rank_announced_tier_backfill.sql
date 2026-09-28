-- 0013 added announced_tier_id empty, and the announcement job emits promo.rank.changed for every
-- player whose rank is ahead of it. Left empty, the first run after an upgrade would congratulate
-- every ranked player on a rank they reached long ago. Nothing was ever announced before this
-- column existed, so the rank each player already holds is treated as told.
UPDATE "promo_player_rank"
SET "announced_tier_id" = "tier_id"
WHERE "announced_tier_id" IS NULL AND "tier_id" IS NOT NULL;
