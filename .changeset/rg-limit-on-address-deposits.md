---
'@openora/core': minor
---

A deposit credited by address (the custody webhook and poller path) is now checked against the player's responsible-gambling deposit limit. The PSP path already refused an over-limit deposit before charging; the address path credited it with no check at all, so a player with a daily limit could deposit any amount on chain and nothing recorded that the limit had been passed.

The funds are already on chain when the webhook lands, so the credit still happens, and the limit is asked after it commits, so two deposits landing together are judged against the same window rather than each against a pre-credit snapshot. A breach files a `rg_limit_breach` reconciliation finding and the usual `wallet.reconciliation_finding.recorded` audit row, so an operator can return the excess. A limit check that fails outright is logged and never blocks the credit.

The finding carries the deposit's own `amount`, `currency` and `transactionId` as columns. The limit side - which limit, which period, how much of the window is used - is prose in `detail`, because the table has no metadata column; it is readable, not queryable. A retried webhook re-files a missing finding, and the `(kind, externalId)` unique index keeps the retry from duplicating one.

`rg_limit_breach` is a new value of `WALLET_RECONCILIATION_FINDING_KINDS`; the wallet migration adds it to the finding kind enum.
