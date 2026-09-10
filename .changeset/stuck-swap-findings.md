---
'@openora/core': minor
---

The wallet reconciliation cycle now reports swaps stuck in `processing`. A `swap_out` leg debits the player before the desk is called; if the process dies before the fill lands, or the desk reports a fill with no amount, the leg stayed `processing` and nothing looked at it again. Past `wallet.reconciliation.stuckAfterMinutes` it now files a `stuck_swap` finding for a human, the same way a stuck custody sweep does. It never refunds or credits on its own, because the desk may already have filled the swap.

`stuck_swap` is a new value of `WALLET_RECONCILIATION_FINDING_KINDS`; the wallet migration adds it to the finding kind enum.
