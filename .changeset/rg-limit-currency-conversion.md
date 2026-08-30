---
'@openora/core': minor
---

Responsible-gambling money limits (`user_limit`) previously summed spend across every currency a player transacted in with zero conversion, so a 100 (any-currency) deposit limit could be defeated by depositing 100 BTC. A limit now carries its own `currency`; historical spend and the money being attempted are both converted into it before comparison, and the check fails closed (refuses the move) whenever a needed exchange rate is unavailable or too stale.

Breaking:

- `RgLimitsPort.checkDeposit`/`checkWager` gain a required third `currency` parameter. Any consumer implementing or stubbing this port (a custom RG_LIMITS binding, or a test double) must update its signature.
- `UpsertLimitInput`, `SetPlayerLimitInput`, and `LimitView` gain a `currency` field: required (non-null) for every money-type limit (`deposit`/`wager`/`loss`), and required-null for the `session` type. An existing caller that omitted `currency` must now supply it.
- `user_limit.amount`/`pendingAmount` widen from `numeric(18,2)` to the platform's shared money scale (`numeric(38,18)`), matching every other money column. This accepts more precision than before (a crypto-scale limit like `0.00000001` now round-trips); it does not narrow what was previously accepted.

Non-breaking but notable: the compliance module now depends on the `exchange-rate` module (`EXCHANGE_RATE_READER`), so an install combining compliance with RG money-limit enforcement must also enable the exchange-rate module.
