---
'@openora/core': minor
---

An on-chain deposit that reaches a player's wallet is now checked against their responsible-gambling deposit limit on both routes that can credit one: the custody webhook, and an admin resolving a reconciliation finding as `credited`. The PSP path already refused an over-limit deposit before charging; these two credited it with no check at all, so a player with a daily limit could deposit any amount on chain and nothing recorded that the limit had been passed.

The funds are already on chain when the webhook lands, so the credit still happens, and the limit is asked after it commits, so two deposits landing together are judged against the same window rather than each against a pre-credit snapshot. A breach files a `rg_limit_breach` reconciliation finding and the usual `wallet.reconciliation_finding.recorded` audit row, so an operator can return the excess. A limit check that fails outright is logged and never blocks the credit.

The hand-credit route needed its own check because the reconciliation poller never credits - it files a `missing_deposit` finding an admin clears with a `manual_credit`, and a `manual_credit` is a row no deposit window counts and no limit refuses. That credit is the attempted move there, where the webhook path asks with `0`. A report that cannot be written never fails the admin's resolution; it is logged.

The finding carries the deposit's own `amount`, `currency` and `transactionId` as columns. The limit side - which limit, which period, how much of the window is used - is prose in `detail`, because the table has no metadata column; it is readable, not queryable. A retried webhook re-files a missing finding, and the `(kind, externalId)` unique index keeps the retry from duplicating one.

`rg_limit_breach` is a new value of `WALLET_RECONCILIATION_FINDING_KINDS`; the wallet migration adds it to the finding kind enum.
