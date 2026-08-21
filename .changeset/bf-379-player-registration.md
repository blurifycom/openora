---
'@openora/core': minor
---

**Breaking:** `identity.register` now accepts a public `username` plus mandatory
terms/age acceptance, and returns `{ status: 'check-email' }` rather than a user
and session. Consumers must configure `registration.termsVersion` and
`registration.webUrl` before enabling registration.

**Breaking:** sign-in requires a verified email address. Any installation with
accounts created before verification was tracked must backfill
`user.email_verified = true` for them, or those accounts cannot sign in.

**Breaking:** the admin `player.update` route no longer accepts `email`. Changing a
player address needs the verified identity email-change flow.

**Breaking:** `PlayerSchema.displayName` is replaced by `username`, including the
`player.list` sort key and the social `FriendListEntry` / `FriendRequestEntry`
payloads. `user.username` is `NOT NULL` and globally unique (case-insensitive), so
every account carries a public handle and no code path can substitute an empty
string for a missing one. Any caller creating users directly must supply one.

Registration no longer creates a session, prevents email enumeration, and records
terms/age consent plus registration IP and user agent on the `player` row through
the new `PLAYER_PROVISIONING` command port. A public username-availability endpoint
is rate-limited and resolves case-insensitively against the `lower(username)` index.

Fixes two latent problems that the unauthenticated verification link makes routine:
`/identity/email/verify` bucketed every session-less caller under one shared
`anonymous` rate-limit key, and only emitted `identity.email.verified` when the
caller already had a session, so the ordinary click-the-link flow left no audit
trail. Both now resolve the subject from the accepted token.
Legacy player names are backfilled by the identity migration; the first holder of a
name keeps it and later holders get a handle suffixed with their user id.
