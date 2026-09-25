---
'@openora/core': minor
---

Adds `cashback` to `BONUS_GRANT_SOURCES` so a scheduled job (a periodic net-loss cashback, not a
deposit) can call `BONUS_GRANTS.grant` with a system actor without misusing the `deposit` or
`manual` source. Also wires an email (`bonusUnlocked`) alongside the existing in-app
`promo.bonus.completed` notification, matching the `raceWon`/`rankChallengeWon` pattern - a
player is now told by email, not just in-app, when a bonus grant clears its wagering
requirement. `PromoOfferRulesSchema` (jsonb, no migration) gains two optional operator-tunable
fields, `freeSpins` and `periodDays`, for offer mechanics core has no dedicated grant shape for
yet. Adds a new command port, `BONUS_LIFECYCLE.forfeit(grantId, reason, note)` - a single named
grant taken away by a system/job context with no admin session to assert, the shape a scheduled
job needs that `forfeitAllFor` (reached only from inside the bonus module) cannot give it.
