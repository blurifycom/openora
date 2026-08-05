---
'@openora/core': patch
---

Add `iam.reportAccessDenied` so a consumer's client-side page guard (e.g. `PermissionGate`) can produce a real audit signal: the guard's own redirect never reaches the server, so on its own it left no trail.

- `POST /iam/report-access-denied` takes `{ resource, level }`, re-verifies the caller's actual permission level server-side, and only emits `identity.user.unauthorized_access` (the same event `AdminGuard` denials produce) when the caller genuinely lacks that level - a caller who actually holds the permission cannot produce a false denial entry.
- Rate-limited per caller/resource (throttle only - a throttled repeat is silently skipped, never surfaced as an error, since this is a fire-and-forget report).
