---
'@openora/core': minor
---

Email and SMS join the authenticator as second-factor delivery methods. All three share the one enrolment better-auth mints; a new `two_factor_method` column on `user` decides only where the code that answers a challenge comes from. `POST /identity/2fa/otp/send` pushes a fresh code to the account's registered address (also the "Resend code" action), and `GET /identity/2fa/status` reports the active method plus the masked destination. A withheld login now names the method it is waiting on, so a client can send the player to the right challenge without a second round-trip.

**Breaking:** `Enable2faResult.totpUri` is now optional. Only the `app` method has a URI to render as a QR code, so `result.totpUri` reads as `string | undefined` downstream. A consumer that renders it unconditionally needs a null check; one that only ever enrols with `method: 'app'` (the default) still always receives it.

- Enrolment refuses an account that already has a live second factor (`409`). A player changes method by disabling and enrolling again - better-auth's enable leg deletes and recreates the enrolment row with a fresh secret and fresh backup codes and marks it verified straight away, so re-running it in place would destroy a working authenticator the moment the call landed.
- `email` enrolment requires a verified email address, the way `sms` already required a verified phone: `requireEmailVerification` is off by default, so an unverified address would otherwise enrol and lock the player out at the next login.
- The pushed code is stored hashed. better-auth defaults `otpOptions.storeOTP` to `"plain"`, which parks a live second factor in `verification.value` in cleartext for the whole of its window; no route reached that endpoint before this release.
- Every step-up now routes by the account's enrolled method, so an `email`/`sms` account can disable 2FA, rotate backup codes and change its phone number. "Trust this device" stays authenticator-only and says so (`409`) rather than failing as a wrong code: it replays a sign-in leg, and a pushed code is keyed to the challenge that requested it.
- A send that the transport rejects answers `503` instead of `200`. better-auth wraps its send hook in `.catch` and answers success regardless, which would leave a player waiting on a code that never left.
- The send leg has its own fail-closed rate limit and honours the 2FA lockout window, so a degraded limiter cannot turn resend into unmetered SMS spend or an unbounded guess budget.

Consumers apply the identity module's `0012` and `0013` migrations (`pnpm db:migrate`). The column is nullable and backfilled to `app` for accounts already enrolled, so existing rows keep working.
