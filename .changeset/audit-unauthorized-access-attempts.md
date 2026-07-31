---
'@openora/core': minor
---

Authorisation denials that never reached `AdminGuard.assert()` were invisible to the audit log: a client-side page guard that blocks navigation before sending any request, and the iam service's own super-admin / grant-escalation checks (`NotSuperAdminError`, `GrantEscalationError`), both bypassed the guard and produced no `identity.user.unauthorized_access` event.

- `AdminGuard.recordDeniedAccess(caller, resource, level)` lets a caller report a denial after the fact. It re-derives the actions for `(resource, level)` and re-checks each one against the caller's real grants - read via the new `AdminPermissionResolver.getFreshGrants` (bypasses the grants cache, so a just-granted permission can't be mis-reported as denied during the cache-purge window) - before emitting the actually-missing action (not just the first one a level expands to, which could be an action the caller already holds). A caller can only ever self-report a denial it genuinely hit; it cannot forge an entry for a resource it can access. Throttled 60s per `(user, resource, level)` via an atomic `RATE_LIMITER.consume` (fixed-window, safe under concurrent requests).
- New iam route `reportAccessDenied` (`POST /iam/access-denied`) exposes it to any admin session.
- `IamService.assertSuperAdmin` and the no-escalation check in `setRolePermissions` now emit `identity.user.unauthorized_access` before throwing, so these service-level denials are audited the same way `AdminGuard` denials always have been.
