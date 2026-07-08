# identity

better-auth-backed authentication + account lifecycle (register, login, logout, 2FA, password reset, email verification, profile). The engine's `SessionResolver`/`AdminGuard` verify sessions against this module's tables (injected, never imported - ADR-0019/0025).

Login lockout: a per-account credential-failure counter (`user.failed_login_attempts` + `lockout_until`); after `maxAttempts` (default 5) failures the account locks for `durationMs` (default 15min). Configurable via `IDENTITY_OPTIONS`. This is correctness-per-account, distinct from the rate limiter below.

Rate limiting: `login`, `register`, `requestPasswordReset`, `resetPassword`, `verify2fa`, and `sendEmailVerification` consume a per-identifier budget via the `RATE_LIMITER` port (keyed by normalized email/token/session, never IP) before doing work - exceeding it throws a 429 (`TOO_MANY_REQUESTS`) with `retryAfterMs`. Defaults are named constants in `identity.service.ts` (login 10/5min, register 5/15min, reset-request 3/15min, reset 5/15min, verify2fa 5/5min, email-verification 3/15min); an overlay rebinds `RATE_LIMITER` to a Redis backend to change policy backend, not the numbers.
