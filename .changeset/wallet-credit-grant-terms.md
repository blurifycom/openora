---
'@openora/core': minor
---

`WALLET_COMMANDS.credit` now accepts optional bonus grant `terms` (wagering multiplier, expiry days, and the rest of `BonusGrantTerms`) for `gift`/`rain` credits, forwarded to `BONUS_GRANTS.grant`. Omitting it keeps today's behaviour: the bonus module's own default terms.
