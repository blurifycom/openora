---
'@openora/core': major
---

Adds a two-step, OTP-confirmed email-change flow and closes two gaps in withdrawal-failure notification, both surfaced by mapping approved mail mockups to code. Also threads who triggered a responsible-gambling change through its mail, and switches mail greetings to the player's username.

- `requestEmailChange`/`confirmEmailChange` mail an OTP to the new address, then swap the login email on a correct code. The request step requires the caller's current password (plus a TOTP code if 2FA is enrolled) and every other session and trusted device is revoked once the swap confirms.
- `wallet.withdrawal.failed` now fires (and mails/notifies the player) on every path that returns held funds, not only an admin-reviewed rejection - an auto-approved payout that failed, or a payment-provider webhook rejecting one later, used to return the funds silently. The audit row for the refund now writes in the same transaction as the credit.
- `wallet.withdrawal.completed` now sends an email; the template key existed but was never wired into the notification map.
- A new `welcome` mail goes out once a registration email is verified.
- Every `rgCoolingOffActivated`/`rgCoolingOffLifted`/`rgLimitUpdated`/`rgSelfExclusionActivated`/`rgSelfExclusionLifted` mail now says who triggered it (`player`, `admin`, or `system`) - including a new mail the cooling-off expiry sweep sends itself, which nobody was sending before.
- Mail greetings resolve from `user.username` instead of the free-typed `user.name`, for every mail addressed by `userId`.
- `MailToAddressInput` (and the underlying mail-send job) gained optional `antiPhishingCode` and `recipientName` fields, so an address-kind send (no user row yet, eg the new inbox during an email change) can carry both.
- **Breaking:** the single `changeEmail` route/schema is removed, replaced by `requestEmailChange` (`POST /identity/email/change/request`) and `confirmEmailChange` (`POST /identity/email/change/confirm`). A consumer calling the old route needs to move to the two-step flow; there is no compatibility shim.
- **Breaking:** `wallet.withdrawal.failed`'s `adminId` is now nullable (event schema version 2 -> 3), reflecting the auto-approved/webhook paths above that have no reviewing admin. A consumer reading `adminId` without a null check breaks at runtime.
- **Breaking:** `EmailTemplateData['emailChanged']` gained required `occurredAt` and `isNewAddress` fields, and `EmailTemplateData['emailChangeConfirmation']` gained required `oldEmail`. A custom `EmailTemplateRenderer` implementation (the default one already covers this) needs to handle both.
- **Breaking:** `EmailTemplateData['rgCoolingOffActivated']`, `['rgCoolingOffLifted']`, `['rgLimitUpdated']`, `['rgSelfExclusionActivated']`, and `['rgSelfExclusionLifted']` all gained a required `initiatedBy` field. A custom `EmailTemplateRenderer` needs to handle it on all five.
