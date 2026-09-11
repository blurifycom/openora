---
'@openora/core': minor
---

Auto-withdrawal thresholds, the daily amount cap and the large-amount heuristic are now read in the fx pivot currency (`exchangeRate.pivot`, `USD` by default) instead of compared raw against whatever currency the withdrawal is in.

One `cryptoThreshold` serves every crypto asset, so a raw comparison made its meaning depend on the coin: a threshold of `1` written with a stablecoin in mind let `0.4 BTC` auto-approve. The daily amount cap summed trailing payouts across currencies as if they were one unit. The withdrawal is now converted once through `EXCHANGE_RATE_READER`, outside the advisory lock, and every comparison is exact decimal instead of `Number()`.

Each auto-approved payout stores its pivot value in the new `wallet_transaction.auto_approval_pivot_amount` column, and the daily amount cap sums those stored values. A rate move after approval cannot shrink what a player already withdrew, and no rate is read while the per-user lock is held.

The `wallet.withdrawal.auto_approved` audit row now carries `pivotAmount` and `pivotCurrency`. `threshold`, `dailyCapAmount` and `cumulativeAmountUsed` are in that pivot currency; `amount` and `currency` stay the raw request.

**Behaviour change:** `fiatThreshold`, `cryptoThreshold`, per-player `auto_withdrawal_rule.threshold` and `autoWithdrawal.dailyCapAmount` are pivot amounts. A threshold configured in coin units reads as a tiny pivot amount after upgrade, so withdrawals route to manual review until an operator re-enters it - the safe direction. When no rate is available for the withdrawal's currency, or the fx module is not loaded, a withdrawal in any currency other than the pivot is not auto-approved; one already in the pivot needs no rate and is still evaluated.

Auto-approvals written before the upgrade have no stored pivot value. While a daily amount cap is configured, a wallet with one in its trailing 24 hours routes to manual review until it ages out, and `cumulativeAmountUsed` is recorded as `null` rather than a partial total.

The review-queue `large_amount` tag still compares the raw amount; it is a display hint, not a decision.
