---
'@openora/core': minor
---

Enforce the country rule on every sign-in path and audit each denial as
`compliance.geo.access_blocked`. Password login (including the 2FA challenge it hands off to),
email-code verification and phone OTP login refuse a blocked country after the credential is
proven, with `FORBIDDEN` / `data.code: 'GEO_BLOCKED'`; `admin` accounts are exempt so staff keep
backoffice access. `GET /compliance/geo-check` is throttled per IP (60/min) and audits a denial
once per IP and country per hour.

**Breaking:** `GeoCheckCommands.checkRegistration` is renamed `checkAccess` (same signature). A
consumer binding its own `GEO_CHECK_COMMANDS` renames the method; callers of the built-in
compliance binding need no change.
