---
'@openora/core': minor
---

**Breaking:** `identity.register` now accepts a public `username` plus mandatory
terms/age acceptance, and returns `{ status: 'check-email' }` rather than a user
and session. Consumers must configure `registration.termsVersion` and
`registration.webUrl` before enabling registration.

Registration no longer creates a session, prevents email enumeration, stores the
registration consent evidence atomically with the identity record, and exposes a
public username-availability endpoint. Public player resolution now uses unique
usernames; legacy player names are backfilled with deterministic collision suffixes.
