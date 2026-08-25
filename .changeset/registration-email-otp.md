---
'@openora/core': minor
---

Registration now mails a six-digit code instead of a magic link, and verifying that code is what mints the session. Sign-up stays sessionless, which is what keeps its duplicate-email answer indistinguishable, so a new player still lands signed in without giving up account enumeration.

Email verification is no longer enforced on sign-in - it moved behind `registration.requireEmailVerification` (default off), so unverified players stay unrestricted while the KYC toggle is off. The RG and suspension gate is now one shared implementation used by password login, phone login, and the new verification path, so a session cannot be handed out through a gate that only some paths enforce.

Upgrading a consumer takes three edits:

- **`registration.webUrl` is gone, replaced by `registration.requireEmailVerification`.** `PlatformConfigSchema` is `.strict()`, so leaving the old key in place does not warn - it throws `Invalid platform config: registration: Unrecognized key: "webUrl"` the first time `PLATFORM_CONFIG` resolves, which is during router construction and therefore before the server ever listens.
- **`verifyEmail` takes `{ email, otp }` instead of `{ token }`** and returns `{ user?, session?, twoFactorRedirect? }` rather than `{ success: true }`. A 2FA-enrolled account is verified but deliberately not signed in: it gets `twoFactorRedirect` and completes the challenge through `login`.
- **`sendEmailVerification` takes `{ email }` and is unauthenticated**, since the player has no session until the code is verified. It always answers success, so it never reveals whether the address has an account.

The `verifyEmail` email template renders an `otp` instead of a `url` - a consumer with its own template renderer must update it, or the mail goes out with an empty body.
