---
'@openora/core': minor
---

Rank rakeback now actually pays: `WAGER_TRACKING` gains a `RakebackService` consumer that credits
a qualifying bet's own-money stake, at the player's rank rakeback percentage (tier rate plus any
active streak boost), straight to their real balance in the same transaction as the bet. No house
edge factor and no claim step - rakeback lands on the balance as it accrues. Only the part of a
stake the player's own funds paid for counts: `WAGER_TRACKING`'s `WagerTrackingArgs` gains a
`realAmount` field alongside `amount`, so a bonus-funded stake never earns real-money rakeback on
funds the player never risked.

A new wallet transaction type, `cashback`, covers this and any other operator-funded real-money
credit that carries no wagering requirement - the daily-streak reward kind `cash` (alongside the
existing `bonus`, `giftDrop` and `rakebackBoost`) uses the same type for a milestone paid straight
to the balance rather than through a bonus grant.

`gamificationContract.ranks` gains a public `lookup` endpoint - a batched, public-fields-only rank
badge lookup for a set of user ids (tier key and name, nothing wagered or earned), for a chat
avatar or profile card to show another player's real rank instead of a placeholder.

Needs a migration: `ALTER TYPE wallet_transaction_type ADD VALUE 'cashback'`.
