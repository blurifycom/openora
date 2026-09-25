---
'@openora/core': minor
---

Responsible-gambling deposit/wager/loss limits now enforce `daily <= weekly <= monthly` server-side, compared in one currency through `EXCHANGE_RATE_READER` when the sibling periods differ in currency. This applies to a player's own limit changes (`RgSelfServiceService.upsertLimit`, evaluated against the effective value - including a parked raise's pending amount, since that is what applies once confirmed) and to the admin reduce-only override (`RgService.setPlayerLimit`, since a decrease can still cross a sibling bound). A limit removal is never subject to this check - dropping a bound only loosens the ordering, never violates it.

A missing exchange rate refuses the whole write rather than skipping the check. Both paths throw the new `LimitOrderingViolationError` (mapped to `CONFLICT`/409), carrying `type`, `period`, `conflictingPeriod` and `bound` (the sibling's effective amount and currency) so a client can render e.g. "Weekly limit can't be lower than your daily limit (29 USD)" without parsing the message.

**Behaviour change:** a limit set that was previously accepted but left `daily`/`weekly`/`monthly` out of order for the same type is now refused. No migration - existing out-of-order rows are left as-is and only block the next attempted change on that type.
