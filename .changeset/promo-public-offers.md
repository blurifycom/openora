---
'@openora/core': minor
---

Bonus offers readable by a signed-out visitor, and offer context on a player's bonuses. All additive.

- `GET /promo/offers/public` (`offers.listPublic`): the live offer catalogue without a session, under the same eligibility predicate as the player list (a first-deposit-only offer is shown, since a visitor has not deposited). Returns only the deal - no opt-in, claim or progress fields. Throttled per IP (`RATE_LIMIT_KEYS.PROMO_PUBLIC_OFFERS_IP`, 60/min) and empty for a visitor the country rule refuses when a `GEO_CHECK_COMMANDS` provider is loaded.
- `PlayerOffer.claimed`: a deposit already turned the player's claim into a bonus, independent of how far back that grant sits in `GET /promo/grants`.
- `PlayerGrant.offerKey` / `offerName` (and on `AdminGrant`): the offer a grant came from, null for a grant with no offer, so a grant whose offer has closed still names it.
