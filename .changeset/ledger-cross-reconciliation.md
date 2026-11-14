---
'@openora/core': minor
---

The wallet reconciliation cycle now holds the ledger against what other services said it should hold, and reports every gap as a finding that only a person can dismiss. None of the checks moves money.

- `ledger_request_mismatch`: a Ledger API request whose answered transaction is missing, or differs in type, currency, key, amount or player. `ledger_api_request` now records the `user_id` and `amount` each request moved; rows from before stay null and skip those two comparisons.
- `ledger_unrequested_transaction`: a bet, win or reversal keyed by a provider with no request under its key, counted only from that provider's first request on, so its legacy rows are never flagged.
- `play_eligibility_drift` and `rg_limits_drift`: the ledger projection is behind its owner's version, or differs from it at the same version. Identity and compliance provide the new sealed `PLAY_ELIGIBILITY_SOURCE` and `RG_LIMITS_SOURCE` ports; without them the check is skipped. The finding closes once the projection catches up.
- `outbox_relay_lag` and `event_dead_letters`: the oldest unrelayed outbox event is older than `wallet.reconciliation.outboxLagAlertMinutes` (default 5), or the broker's dead-letter streams hold more than `wallet.reconciliation.deadLetterAlertThreshold` entries (default 0). One finding for the pipeline, never one per event, closed once the backlog clears. `MessageBrokerAdapter` gains an optional `deadLetterCount()`, implemented by the Redis Streams broker.

Every new finding raises `wallet.reconciliation.alert` in the transaction that files it. The six kinds are new values of `WALLET_RECONCILIATION_FINDING_KINDS`; the wallet migration adds them to the finding kind enum, two nullable columns and an index on `ledger_api_request.created_at`.
