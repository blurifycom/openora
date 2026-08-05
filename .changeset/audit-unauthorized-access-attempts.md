---
'@openora/core': patch
---

The iam service's own super-admin / grant-escalation checks (`NotSuperAdminError`, `GrantEscalationError`) threw before ever reaching `AdminGuard.assert()`, so they produced no `identity.user.unauthorized_access` event even though the request genuinely hit the backend and was genuinely denied.

- `IamService.assertSuperAdmin` and the no-escalation check in `setRolePermissions` now emit `identity.user.unauthorized_access` before throwing, so these service-level denials are audited the same way `AdminGuard` denials always have been.

Frontend route guards are deliberately out of scope: a client-side redirect never sends the underlying request, so it is not a reliable audit signal - only a real backend request that hits `AdminGuard.assert()` (or one of the two service-level checks above) is.
