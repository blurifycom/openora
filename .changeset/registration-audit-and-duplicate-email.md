---
'@openora/core': minor
---

Registration now leaves an audit trail whether or not it produces an account, and a sign-up on an address that already has one gets its own email instead of a bare password-reset code.

**Rejected attempts are audited.** New `identity.user.registration.failed` domain event, emitted by every path in `IdentityService.register` that ends without an account - registration not configured, either rate limit, a geo block, a taken username, a failed sign-up, and a consent write that had to roll the user back. It carries the address, the attempted username, the origin (IP and user agent) and a typed `reason`; the audit plugin subscribes to it and files it under `resourceType: 'registration'` with `result: 'failure'`. Previously only successes were recorded, so a log of registration activity showed nothing but the attempts that worked.

The known-address branch emits it too, with `reason: 'email_already_registered'`. The HTTP response is unchanged and still indistinguishable from a fresh sign-up - the audit log records what happened, the response deliberately does not, because a truthful answer there is an account-enumeration oracle.

**The accepted terms reach the audit log.** `identity.user.registered` now carries `termsVersion`, `acceptedTerms` and `acceptedAge`. They are omitted when the consent write was discarded because a player row already existed, so the trail never implies evidence that was not stored. The `player` row already held the current values; it is not a record of the act.

**New `existingAccountSignUp` email template key.** better-auth issues both the self-service reset and the duplicate-sign-up notice through the same `forget-password` OTP type, so a renderer could not tell them apart and the second one went out as "Your password reset code is: …" to a player who had asked for no such thing. `createAuth` takes an `isExistingAccountSignUp` predicate and picks the new key; the shipped copy explains that no new account was created and offers the code as a reset.

Adding the key is minor-breaking for a consumer whose renderer is backed by a full `Record<EmailTemplateKey, …>` map - it will not compile until the new entry exists. A renderer that switches on the key with a fallback is unaffected.

**Password rules match across the flows that set one.** `PasswordSchema` (min 8, max 128) is now shared by sign-up, password change and password reset. Sign-up previously had no upper bound, so an over-length password passed the contract and was rejected by better-auth as a generic "Registration is unavailable". Sign-in is deliberately left uncapped: no longer password was ever storable, so a bound there could only narrow an existing contract.
