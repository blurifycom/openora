---
'@openora/core': minor
---

Auto-withdrawal thresholds, the daily amount cap and the large-amount heuristic are now read in the fx pivot currency (`exchangeRate.pivot`, `USD` by default) instead of compared raw against whatever currency the withdrawal is in.

One `cryptoThreshold` serves every crypto asset, so a raw comparison made its meaning depend on the coin: a threshold of `1` written with a stablecoin in mind let `0.4 BTC` auto-approve. The daily amount cap summed trailing payouts across currencies as if they were one unit. Both now convert through `EXCHANGE_RATE_READER`, and every comparison is exact decimal instead of `Number()`.

**Behaviour change:** `fiatThreshold`, `cryptoThreshold`, per-player `auto_withdrawal_rule.threshold` and `autoWithdrawal.dailyCapAmount` are pivot amounts. A threshold configured in coin units reads as a tiny pivot amount after upgrade, so withdrawals route to manual review until an operator re-enters it - the safe direction. When no rate is available for the withdrawal's currency, or the fx module is not loaded, the withdrawal is not auto-approved.

The review-queue `large_amount` tag still compares the raw amount; it is a display hint, not a decision.
