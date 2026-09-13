---
'@openora/core': minor
---

The wallet reconciliation cycle now reports swaps stuck in `processing`. A `swap_out` leg debits the player before the desk is called; if the process dies before the fill lands, or the desk reports a fill with no amount, the leg stayed `processing` and nothing looked at it again. Past `wallet.reconciliation.stuckSwapAfterMinutes` it now files a `stuck_swap` finding for a human, the same way a stuck custody sweep does. It never refunds or credits on its own, because the desk may already have filled the swap.

`stuckSwapAfterMinutes` is a new optional knob that falls back to `stuckAfterMinutes`. Swaps need their own number because `processing` is a legitimate resting state for a swap leg waiting on an asynchronous desk fill, so the withdrawal cutoff would report every healthy swap at a desk that settles slower than withdrawals.

The cycle also closes a `stuck_swap` finding whose leg the desk settled after it was reported, writing a resolution note. That is a report-side write only: it never touches a balance, a transaction status, or the swap itself.

`stuck_swap` is a new value of `WALLET_RECONCILIATION_FINDING_KINDS`; the wallet migration adds it to the finding kind enum.
