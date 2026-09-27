---
'@openora/core': minor
---

Withdrawal KYC now follows the global KYC switch and two thresholds instead of demanding an approved status for every withdrawal. `global_kyc_config` gains `withdrawal_threshold` (nullable, no single-withdrawal trigger when null) and `cumulative_deposit_threshold` (default `10000`), both in the fx pivot. While KYC is enabled, a withdrawal needs an approved KYC status once the player's completed deposits exceed the cumulative threshold, or when the withdrawal exceeds the withdrawal threshold. While it is disabled, no withdrawal needs KYC. An amount or deposit currency that cannot be priced requires KYC.

`GlobalKycConfig` (`getGlobalKycConfig`, `setGlobalKycConfig`) gains `withdrawalThreshold` and `cumulativeDepositThreshold`. `SetGlobalKycConfigInput` accepts both as optional; an omitted field is left unchanged. A change to either is audited on `compliance.global_kyc.set`.

New port `KYC_WITHDRAWAL_POLICY` (`requiresKycForWithdrawal`), bound by compliance. `kyc.gateWithdrawals` stays the switch for the request-time check; when on, the wallet asks the policy and refuses with `KycRequiredError` before any debit. Auto-approval always asks the policy, so a player who needs no KYC can now be auto-approved without an approved status. Without a bound policy, every gated withdrawal needs an approved status, as before.

**Behaviour change:** the catalog's `withdrawal_fee` is now charged. The player is debited the entered amount, the provider is asked to pay out the amount minus the fee, and `wallet_transaction.fee` (new nullable column) records it. An amount that does not exceed the fee is refused with `WithdrawalAmountNotAboveFeeError` (`400`). A rejection or failure refunds the full debited amount. `WalletTransaction`, `AdminWalletTransaction` and `WithdrawalQueueItem` gain a nullable `fee`.
