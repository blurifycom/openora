---
'@openora/core': minor
---

**Breaking:** `identity.register` now accepts a public `username` plus mandatory
terms/age acceptance, and returns `{ status: 'check-email' }` rather than a user
and session. Consumers must configure `registration.termsVersion` and
`registration.webUrl` before enabling registration.

**Breaking:** sign-in requires a verified email address
(`emailAndPassword.requireEmailVerification`). Existing installations must mark
already-trusted accounts `user.email_verified = true` before deploying.

**Breaking:** the admin `player.update` route no longer accepts `email`. Changing a
player address needs the verified identity email-change flow.

**Breaking:** `PlayerSchema.displayName` is replaced by `username`, including the
`player.list` sort key and the social `FriendListEntry` / `FriendRequestEntry`
payloads.

Registration no longer creates a session, prevents email enumeration, and records
terms/age consent plus registration IP and user agent on the `player` row through
the new `PLAYER_PROVISIONING` command port. A public username-availability endpoint
is rate-limited and resolves case-insensitively against the `lower(username)` index.
Legacy player names are backfilled by the identity migration; the first holder of a
name keeps it and later holders get a handle suffixed with their user id.
