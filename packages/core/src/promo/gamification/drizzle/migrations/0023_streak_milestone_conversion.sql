UPDATE "promo_streak_config" SET
	"enabled" = false,
	"currency" = 'USD',
	"rakeback_milestones" = '[]'::jsonb,
	"fixed_rewards" = COALESCE((
		SELECT jsonb_agg(
			jsonb_build_object(
				'day', (m.milestone ->> 'day')::int,
				'amount', b.reward ->> 'amount',
				'rolloverMultiplier', b.reward -> 'terms' ->> 'wageringMultiplier',
				'claimExpiryDays', (b.reward -> 'terms' ->> 'expiryDays')::int
			)
			ORDER BY (m.milestone ->> 'day')::int
		)
		FROM jsonb_array_elements("promo_streak_config"."milestones") AS m(milestone)
		CROSS JOIN LATERAL (
			SELECT r AS reward
			FROM jsonb_array_elements(m.milestone -> 'rewards') AS r
			WHERE r ->> 'kind' = 'bonus'
			LIMIT 1
		) AS b
		WHERE (m.milestone ->> 'day')::int BETWEEN 1 AND 35
			AND (b.reward ->> 'amount')::numeric > 0
			AND (b.reward -> 'terms' ->> 'wageringMultiplier')::numeric > 0
			AND (b.reward -> 'terms' ->> 'wageringMultiplier')::numeric <= 1000
			AND (b.reward -> 'terms' ->> 'expiryDays')::int BETWEEN 1 AND 365
	), '[]'::jsonb);--> statement-breakpoint
UPDATE "promo_streak_milestone_grant" AS g SET
	"amount" = (fr ->> 'amount')::numeric,
	"rollover_multiplier" = (fr ->> 'rolloverMultiplier')::numeric,
	"claim_expiry_days" = (fr ->> 'claimExpiryDays')::int,
	"expires_at" = now() + ((fr ->> 'claimExpiryDays')::int * interval '1 day')
FROM "promo_streak_config" AS c, jsonb_array_elements(c."fixed_rewards") AS fr
WHERE g."settled_at" IS NULL
	AND (fr ->> 'day')::int = g."day";--> statement-breakpoint
UPDATE "promo_streak_milestone_grant" SET
	"settled_at" = now(),
	"outcome" = 'expired'
WHERE "settled_at" IS NULL
	AND "expires_at" IS NULL;
