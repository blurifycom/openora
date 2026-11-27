---
'@openora/core': patch
---

A withdrawal refused because KYC is required now writes a `wallet.withdrawal.kyc_required` audit row (actor the user, resource the player, `after` carrying `amount` and `currency`) before the unchanged `409`. The write is best-effort: a failure is logged and the refusal still returns. No funds move on this path.
