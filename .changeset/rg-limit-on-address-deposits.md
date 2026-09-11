---
'@openora/core': minor
---

A deposit credited by address (the custody webhook and poller path) is now checked against the player's responsible-gambling deposit limit. The PSP path already refused an over-limit deposit before charging; the address path credited it with no check at all, so a player with a daily limit could deposit any amount on chain and nothing recorded that the limit had been passed.

The funds are already on chain when the webhook lands, so the credit still happens. What changes is that an over-limit deposit files a `rg_limit_breach` reconciliation finding (with the limit, the period and what was already used) and the usual `wallet.reconciliation_finding.recorded` audit row, so an operator can return the excess. A limit check that fails outright is logged and never blocks the credit.

`rg_limit_breach` is a new value of `WALLET_RECONCILIATION_FINDING_KINDS`; the wallet migration adds it to the finding kind enum.
