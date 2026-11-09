UPDATE "promo_streak_config" SET
	"enabled" = false,
	"rakeback_milestones" = '[]'::jsonb,
	"fixed_rewards" = COALESCE((
		SELECT jsonb_agg(
			jsonb_build_object(
				'day', (m.milestone ->> 'day')::int,
				'amount', b.reward ->> 'amount',
				'rolloverMultiplier', b.reward -> 'terms' ->> 'wageringMultiplier',
				'claimExpiryDays', (b.reward -> 'terms' ->> 'expiryDays')::int,
				'maxBet', CASE
					WHEN (b.reward -> 'terms' ->> 'maxBet')::numeric > 0 THEN b.reward -> 'terms' ->> 'maxBet'
				END
			)
			ORDER BY (m.milestone ->> 'day')::int
		)
		FROM jsonb_array_elements("promo_streak_config"."milestones") AS m(milestone)
		CROSS JOIN LATERAL (
			SELECT r.reward
			FROM jsonb_array_elements(m.milestone -> 'rewards') WITH ORDINALITY AS r(reward, ordinal)
			WHERE r.reward ->> 'kind' = 'bonus'
			ORDER BY r.ordinal
			LIMIT 1
		) AS b
		WHERE "promo_streak_config"."currency" = 'USD'
			AND (m.milestone ->> 'day')::int BETWEEN 1 AND 35
			AND (b.reward ->> 'amount')::numeric > 0
			AND (b.reward -> 'terms' ->> 'wageringMultiplier')::numeric > 0
			AND (b.reward -> 'terms' ->> 'wageringMultiplier')::numeric <= 1000
			AND (b.reward -> 'terms' ->> 'expiryDays')::int BETWEEN 1 AND 365
	), '[]'::jsonb),
	"milestones" = '[]'::jsonb;--> statement-breakpoint
UPDATE "promo_streak_milestone_grant" AS g SET
	"amount" = (fr ->> 'amount')::numeric,
	"rollover_multiplier" = (fr ->> 'rolloverMultiplier')::numeric,
	"claim_expiry_days" = (fr ->> 'claimExpiryDays')::int,
	"max_bet" = (fr ->> 'maxBet')::numeric,
	"expires_at" = now() + ((fr ->> 'claimExpiryDays')::int * interval '1 day')
FROM "promo_streak_config" AS c, jsonb_array_elements(c."fixed_rewards") AS fr
WHERE g."settled_at" IS NULL
	AND (fr ->> 'day')::int = g."day";--> statement-breakpoint
DELETE FROM "promo_streak_round_wager"
WHERE EXISTS (SELECT 1 FROM "promo_streak_config" WHERE "currency" <> 'USD');--> statement-breakpoint
DELETE FROM "promo_streak_daily_wager" WHERE "currency" <> 'USD';
