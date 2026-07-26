# identity

better-auth-backed authentication and account lifecycle (register, login, logout, 2FA, password reset, email verification, profile). The engine's `SessionResolver`/`AdminGuard` verify sessions against this module's tables by injection, never by importing them (ADR-0019/0025).

## Login lockout

Per-account credential-failure counter (`user.failed_login_attempts` + `lockout_until`): after `maxAttempts` (default 5) the account locks, and a repeat lockout inside a rolling 24h window escalates 1min -> 5min -> 15min (`lockout_count` + `last_lockout_at`; the window resets once `last_lockout_at` ages out, `IDENTITY_OPTIONS.lockout.durationMs` is the tier-3+ fallback). `identity.user.login.failed` carries `attemptsRemaining` so a client can prompt a reset as the count runs down. Per-account correctness, distinct from rate limiting below.

Anti-enumeration: a nonexistent email has no row to hold that state, so the same `computeLockoutState`/`computeLockoutTier` functions run against a `CACHE`-backed shadow record (`login-shadow:<email>`, 7d TTL) - repeated wrong passwords on a fake email eventually return the identical `ACCOUNT_LOCKED` response, with no `identity.user.lockout.triggered` (no real userId to attach). `cache` is an optional constructor dep: unbound or erroring, the mirroring silently no-ops and that path degrades to a static reply.

## Phone login (SMS OTP)

A standalone method for players with a verified phone (`user.phone_number` E.164 + `phone_verified`; phone management routes are a separate story). Request sends a 6-digit code via the `SMS_ADAPTER` port (default mock logs to stdout; an overlay rebinds Twilio/SNS) and returns the SAME `{ expiresAt, resendAfter }` whether or not the phone is registered - 60s resend cooldown, one live code per user, SHA-256 hashed in `sms_otp_session`, 5min TTL. Verify mints the session DIRECTLY in the `session` table, bypassing better-auth's TOTP plugin chain: TOTP 2FA does NOT apply to phone login, by design. The RG login block is enforced after the OTP verifies, same as password login.

Wrong codes increment `failed_attempts` (5-attempt cap, then the session cancels) and throw `OtpInvalidError` (`UNPROCESSABLE_CONTENT`) with `data: { attemptsRemaining, reason }` so the caller can tell `wrong_code` from `expired` instead of inferring it. Unknown, unverified, or just-cancelled phones are mirrored through the same shadow-record trick (`phone-otp-shadow:<phone>`, 7d physical TTL, logical 5min expiry derived from the stored `createdAt`), so cooldown/attempt/expiry behavior is indistinguishable from a real session - same optional-cache, silent-degrade contract as lockout.

## Rate limiting

Auth-sensitive routes consume a per-identifier budget via `RATE_LIMITER` (keyed by normalized email/token/session, NEVER IP) before doing any work, then throw 429 with `retryAfterMs`. The numbers are named constants in `identity.service.ts`; an overlay rebinds `RATE_LIMITER` to change the backend, not the policy.

## Password reset

Two-step OTP: request emails it, `verifyPasswordResetOtp` lets the client check it up front for immediate feedback WITHOUT consuming it, and `resetPassword` is the sole authoritative call that validates and sets. Both read the same better-auth verification row (`forget-password:<email>`), so splitting the flow grants no extra guesses beyond better-auth's `allowedAttempts`.
